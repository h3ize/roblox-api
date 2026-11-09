import { fetchApi } from "rozod";
import { getUsersUserid, getUsersUseridUsernameHistory } from "rozod/lib/endpoints/usersv1";
import {
  getUsersUseridFriendsCount,
  getUsersTargetuseridFollowersCount,
  getUsersTargetuseridFollowingsCount,
} from "rozod/lib/endpoints/friendsv1";

const ROBLOX = {
  users: "https://users.roblox.com",
  avatar: "https://avatar.roblox.com",
  catalog: "https://catalog.roblox.com",
  economy: "https://economy.roblox.com",
  groups: "https://groups.roblox.com",
  games: "https://games.roblox.com",
  presence: "https://presence.roblox.com",
  friends: "https://friends.roblox.com",
  badges: "https://badges.roblox.com",
  thumbnails: "https://thumbnails.roblox.com",
  inventory: "https://inventory.roblox.com",
};

const ROLIMONS = "https://api.rolimons.com";

const DEFAULT_HEADERS = {
  "user-agent": "ProfileViewer-CloudflareWorker/3.4",
  "accept": "application/json",
};

const UPSTREAM_ATTEMPTS = 4;

// Per-host lanes for /full-profile: different hosts run at the same time,
// requests to the same host run one after another.
const LANES = {
  profile: "users",
  usernameHistory: "users",
  avatar: "avatar",
  wearing: "avatar",
  outfits: "avatar",
  groups: "groups",
  friendsCount: "friends",
  followersCount: "friends",
  followingCount: "friends",
  badges: "badges",
};

// In-memory cache (per isolate, best effort).
// Fresh entries are served instantly; stale entries are served when Roblox rate limits us.
const MEM = new Map();
const FRESH_MS = 5 * 60_000;
const STALE_MS = 60 * 60_000;

function memGet(key) {
  const entry = MEM.get(key);
  return entry && Date.now() - entry.at < STALE_MS ? entry : null;
}

function memSet(key, result) {
  MEM.set(key, { at: Date.now(), result });
  if (MEM.size > 500) {
    MEM.delete(MEM.keys().next().value);
  }
}

let robloxCookie = "";

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

function asInt(value, fallback, min = 1, max = 100) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n)
    ? Math.max(min, Math.min(max, n))
    : fallback;
}

function enc(value) {
  return encodeURIComponent(String(value ?? ""));
}

function cleanCursor(value) {
  return typeof value === "string" ? value : "";
}

function validId(value) {
  return /^\d+$/.test(String(value || ""));
}

function numericIds(value, max = 50) {
  return String(value || "")
    .split(",")
    .filter(validId)
    .slice(0, max);
}

function getLimit(url, fallback = 50, max = 100) {
  return asInt(
    url.searchParams.get("limit"),
    fallback,
    1,
    max
  );
}

function pagination(url, fallback = 50, max = 100) {
  const query = new URLSearchParams({
    limit: String(getLimit(url, fallback, max)),
    sortOrder: url.searchParams.get("sortOrder") || "Asc",
  });
  const cursor = cleanCursor(
    url.searchParams.get("cursor")
  );
  if (cursor) {
    query.set("cursor", cursor);
  }
  return query;
}

function routeMatch(path, expression) {
  const match = path.match(expression);
  return match ? match.slice(1) : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function rz(endpoint, params, fallbackUrl) {
  const cachedHit = fallbackUrl ? memGet(fallbackUrl) : null;
  if (cachedHit && Date.now() - cachedHit.at < FRESH_MS) {
    return { ...cachedHit.result, via: "cache" };
  }

  let result = null;
  try {
    const response = await Promise.race([
      fetchApi(endpoint, params, { returnRaw: true, retries: 0 }),
      sleep(6000).then(() => null),
    ]);
    if (response) {
      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text.slice(0, 2000) };
      }
      result = {
        ok: response.ok,
        status: response.status,
        data,
        via: "rozod",
      };
    }
  } catch {}

  const finalClientError = result
    && result.status >= 400
    && result.status < 500
    && result.status !== 429;

  if (result && (result.ok || finalClientError)) {
    if (result.ok && fallbackUrl) {
      memSet(fallbackUrl, result);
    }
    return result;
  }

  if (fallbackUrl) {
    return upstream(fallbackUrl);
  }

  return result || {
    ok: false,
    status: 502,
    data: { errors: [{ message: "RoZod request failed" }] },
    via: "rozod",
  };
}

function respond(result) {
  return json(result.data, result.status);
}

async function upstream(url, options = {}) {
  const method = options.method || "GET";
  const hit = method === "GET" ? memGet(url) : null;
  if (hit && Date.now() - hit.at < FRESH_MS) {
    return { ...hit.result, via: "cache" };
  }

  const headers = new Headers(DEFAULT_HEADERS);
  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      headers.set(key, value);
    }
  }

  let last = null;
  const log = [];

  for (let attempt = 0; attempt < UPSTREAM_ATTEMPTS; attempt++) {
    const needsCookie = robloxCookie !== "" && new URL(url).hostname === "badges.roblox.com";
    const attemptHeaders = new Headers(headers);
    if (needsCookie) {
      attemptHeaders.set("cookie", `.ROBLOSECURITY=${robloxCookie}`);
    }

    try {
      const response = await fetch(url, {
        method,
        headers: attemptHeaders,
        body: options.body,
        redirect: "follow",
        signal: AbortSignal.timeout(12000),
        cf: {
          cacheTtlByStatus: { "100-599": -1 },
        },
      });

      log.push({ host: new URL(url).host, status: response.status });

      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {
          raw: text.slice(0, 2000),
        };
      }

      if (response.status === 429) {
        last = {
          ok: false,
          status: 429,
          data,
          via: url,
          attempts: log,
        };
        await sleep(600 * (attempt + 1) + Math.floor(Math.random() * 300));
        continue;
      }

      const result = {
        ok: response.ok,
        status: response.status,
        data,
        via: url,
        attempts: log,
      };

      if (method === "GET" && response.ok) {
        memSet(url, result);
      }

      return result;
    } catch (error) {
      log.push({ host: new URL(url).host, status: "error" });
      last = {
        ok: false,
        status: 502,
        data: {
          errors: [{
            message: "Upstream request failed",
            details: String(error),
          }],
        },
        via: url,
        attempts: log,
      };
    }
  }

  // Rate limited or failing: serve the last good copy if we have one
  if (hit) {
    return { ...hit.result, via: "stale-cache" };
  }

  return last;
}

async function proxy(url, options = {}) {
  const result = await upstream(url, options);
  return json(result.data, result.status);
}

async function aggregate(endpoints) {
  const lanes = {};
  for (const [key, endpoint] of Object.entries(endpoints)) {
    (lanes[LANES[key] || key] ||= []).push([key, endpoint]);
  }

  const results = {};
  await Promise.all(Object.values(lanes).map(async (lane) => {
    for (const [key, endpoint] of lane) {
      const result = typeof endpoint === "function" ? await endpoint() : await upstream(endpoint);
      results[key] = {
        success: result.ok,
        status: result.status,
        via: result.via,
        attempts: result.attempts,
        data: result.data,
      };
    }
  }));
  return results;
}

async function handle(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (method !== "GET" && method !== "POST") {
    return json({
      ok: false,
      error: "Method not allowed",
    }, 405);
  }

  if (method === "GET" && path === "/") {
    return json({
      ok: true,
      service: "Roblox Profile Viewer API",
      version: "3.4",
      description: "Public Roblox profile and game information API",
      categories: {
        users: [
          "/user/:userId",
          "/user-search/:keyword",
          "/resolve-username/:username",
          "/username-history/:userId",
          "/full-profile/:userId",
        ],
        avatars: [
          "/avatar/:userId",
          "/avatar-thumbnail/:userId",
          "/headshot/:userId",
          "/avatars?userIds=ID,ID",
          "/headshots?userIds=ID,ID",
          "/wearing/:userId",
          "/outfits/:userId",
          "/outfit-details/:outfitId",
          "/outfit-thumbnail/:outfitId",
          "/asset-thumbnail/:assetId",
        ],
        relationships: [
          "/friends/:userId",
          "/friends-count/:userId",
          "/followers/:userId",
          "/followers-count/:userId",
          "/following/:userId",
          "/following-count/:userId",
        ],
        groups: [
          "/user-groups/:userId",
          "/group/:groupId",
          "/group-icon/:groupId",
          "/group-members/:groupId",
          "/group-member-count/:groupId",
          "/group-roles/:groupId",
          "/group-role-details/:groupId/:roleId",
          "/group-role-users/:groupId/:roleId",
          "/group-games/:groupId",
          "/group-store/:categoryId/:groupId",
          "/group-store-keyword/:categoryId/:keyword",
        ],
        games: [
          "/user-games/:userId",
          "/user-favorites/:userId",
          "/games-info/:universeIds",
          "/game-details/:universeId",
          "/game-votes/:universeId",
          "/game-icon/:universeId",
          "/game-thumbnails/:universeId",
          "/game-servers/:placeId",
        ],
        badges: [
          "/user-badges/:userId",
          "/badge/:badgeId",
        ],
        inventory: [
          "/inventory/:userId",
          "/collectibles/:userId",
        ],
        catalog: [
          "/catalog-search/:categoryId/:keyword",
          "/catalog-item/:assetId",
          "/asset-bundles/:assetId",
          "/bundle-details/:bundleId",
          "/limited-resale/:assetId",
        ],
        presence: [
          "POST /presence/users",
        ],
        rolimons: [
          "/rolimons-player/:userId",
          "/rolimons-items",
        ],
      },
    });
  }

  let p = routeMatch(path, /^\/user\/(\d+)$/);
  if (method === "GET" && p) {
    return respond(await rz(getUsersUserid, { userId: Number(p[0]) }, `${ROBLOX.users}/v1/users/${p[0]}`));
  }

  p = routeMatch(path, /^\/user-search\/(.+)$/);
  if (method === "GET" && p) {
    const query = new URLSearchParams({
      keyword: p[0],
      limit: String(getLimit(url, 10, 25)),
    });
    return proxy(
      `${ROBLOX.users}/v1/users/search?${query}`
    );
  }

  p = routeMatch(path, /^\/resolve-username\/([^/]+)$/);
  if (method === "GET" && p) {
    return proxy(
      `${ROBLOX.users}/v1/usernames/users`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          usernames: [p[0]],
          excludeBannedUsers: false,
        }),
      }
    );
  }

  p = routeMatch(path, /^\/username-history\/(\d+)$/);
  if (method === "GET" && p) {
    const wanted = getLimit(url, 100, 100);
    const limit = [10, 25, 50, 100].find(n => n >= wanted) || 100;
    const cursor = cleanCursor(url.searchParams.get("cursor"));
    const params = { userId: Number(p[0]), limit };
    if (cursor) params.cursor = cursor;
    const historyQuery = new URLSearchParams({ limit: String(limit) });
    if (cursor) historyQuery.set("cursor", cursor);
    return respond(await rz(
      getUsersUseridUsernameHistory,
      params,
      `${ROBLOX.users}/v1/users/${p[0]}/username-history?${historyQuery}`
    ));
  }

  p = routeMatch(path, /^\/avatar\/(\d+)$/);
  if (method === "GET" && p) {
    return proxy(
      `${ROBLOX.avatar}/v1/users/${p[0]}/avatar`
    );
  }

  p = routeMatch(path, /^\/wearing\/(\d+)$/);
  if (method === "GET" && p) {
    return proxy(
      `${ROBLOX.avatar}/v1/users/${p[0]}/currently-wearing`
    );
  }

  // ── OUTFITS (v2) ──────────────────────────────────────────────────────────
  p = routeMatch(path, /^\/outfits\/(\d+)$/);
  if (method === "GET" && p) {
    const query = new URLSearchParams({
      itemsPerPage: String(getLimit(url, 50, 100)),
    });

    // Prefer paginationToken (v2 style). Fall back to page for compatibility.
    const paginationToken = cleanCursor(
      url.searchParams.get("paginationToken") || url.searchParams.get("cursor")
    );
    if (paginationToken) {
      query.set("paginationToken", paginationToken);
    } else {
      const page = url.searchParams.get("page");
      if (page) {
        query.set("page", String(asInt(page, 1, 1, 1000)));
      }
    }

    const isEditable = url.searchParams.get("isEditable");
    if (isEditable !== null && isEditable !== "") {
      query.set("isEditable", isEditable === "true" ? "true" : "false");
    }

    const outfitType = url.searchParams.get("outfitType"); // Avatar, DynamicHead, Shoes, Makeup...
    if (outfitType) {
      query.set("outfitType", outfitType);
    }

    return proxy(
      `${ROBLOX.avatar}/v2/avatar/users/${p[0]}/outfits?${query}`
    );
  }

  p = routeMatch(path, /^\/outfit-details\/(\d+)$/);
  if (method === "GET" && p) {
    return proxy(
      `${ROBLOX.avatar}/v1/outfits/${p[0]}/details`
    );
  }

  p = routeMatch(path, /^\/avatar-thumbnail\/(\d+)$/);
  if (method === "GET" && p) {
    const query = new URLSearchParams({
      userIds: p[0],
      size: url.searchParams.get("size") || "420x420",
      format: url.searchParams.get("format") || "Png",
      isCircular: url.searchParams.get("isCircular") || "false",
    });
    return proxy(
      `${ROBLOX.thumbnails}/v1/users/avatar?${query}`
    );
  }

  p = routeMatch(path, /^\/headshot\/(\d+)$/);
  if (method === "GET" && p) {
    const query = new URLSearchParams({
      userIds: p[0],
      size: url.searchParams.get("size") || "150x150",
      format: url.searchParams.get("format") || "Png",
      isCircular: url.searchParams.get("isCircular") || "false",
    });
    return proxy(
      `${ROBLOX.thumbnails}/v1/users/avatar-headshot?${query}`
    );
  }

  p = routeMatch(path, /^\/outfit-thumbnail\/(\d+)$/);
  if (method === "GET" && p) {
    const query = new URLSearchParams({
      userOutfitIds: p[0],
      size: url.searchParams.get("size") || "420x420",
      format: url.searchParams.get("format") || "Png",
    });
    return proxy(
      `${ROBLOX.thumbnails}/v1/users/outfits?${query}`
    );
  }

  p = routeMatch(path, /^\/asset-thumbnail\/(\d+)$/);
  if (method === "GET" && p) {
    const query = new URLSearchParams({
      assetIds: p[0],
      size: url.searchParams.get("size") || "420x420",
      format: url.searchParams.get("format") || "Png",
    });
    return proxy(
      `${ROBLOX.thumbnails}/v1/assets?${query}`
    );
  }

  for (const type of ["headshots", "avatars"]) {
    if (method === "GET" && path === `/${type}`) {
      const ids = numericIds(
        url.searchParams.get("userIds"),
        50
      );
      if (!ids.length) {
        return json({
          ok: false,
          error: "Provide userIds.",
        }, 400);
      }
      const query = new URLSearchParams({
        userIds: ids.join(","),
        size: url.searchParams.get("size") ||
          (type === "avatars" ? "420x420" : "150x150"),
        format: "Png",
        isCircular: "false",
      });
      const endpoint = type === "avatars"
        ? "avatar"
        : "avatar-headshot";
      return proxy(
        `${ROBLOX.thumbnails}/v1/users/${endpoint}?${query}`
      );
    }
  }

  const relationshipRoutes = [
    ["friends", "friends"],
    ["followers", "followers"],
    ["following", "followings"],
  ];
  if (method === "GET") {
    for (const [route, endpoint] of relationshipRoutes) {
      p = routeMatch(path, new RegExp(`^/${route}/(\\d+)$`));
      if (p) {
        const query = pagination(url, 50, 100);
        return proxy(
          `${ROBLOX.friends}/v1/users/${p[0]}/${endpoint}?${query}`
        );
      }
    }
  }

  const countRoutes = [
    ["friends-count", getUsersUseridFriendsCount, "userId", "friends"],
    ["followers-count", getUsersTargetuseridFollowersCount, "targetUserId", "followers"],
    ["following-count", getUsersTargetuseridFollowingsCount, "targetUserId", "followings"],
  ];
  if (method === "GET") {
    for (const [route, endpoint, key, segment] of countRoutes) {
      p = routeMatch(path, new RegExp(`^/${route}/(\\d+)$`));
      if (p) {
        return respond(await rz(endpoint, { [key]: Number(p[0]) }, `${ROBLOX.friends}/v1/users/${p[0]}/${segment}/count`));
      }
    }
  }

  p = routeMatch(path, /^\/user-groups\/(\d+)$/);
  if (method === "GET" && p) {
    return proxy(
      `${ROBLOX.groups}/v2/users/${p[0]}/groups/roles`
    );
  }

  p = routeMatch(path, /^\/group\/(\d+)$/);
  if (method === "GET" && p) {
    return proxy(
      `${ROBLOX.groups}/v1/groups/${p[0]}`
    );
  }

  p = routeMatch(path, /^\/group-icon\/(\d+)$/);
  if (method === "GET" && p) {
    const query = new URLSearchParams({
      groupIds: p[0],
      size: url.searchParams.get("size") || "420x420",
      format: "Png",
    });
    return proxy(
      `${ROBLOX.thumbnails}/v1/groups/icons?${query}`
    );
  }

  p = routeMatch(path, /^\/group-roles\/(\d+)$/);
  if (method === "GET" && p) {
    return proxy(
      `${ROBLOX.groups}/v1/groups/${p[0]}/roles`
    );
  }

  p = routeMatch(path, /^\/group-role-details\/(\d+)\/(\d+)$/);
  if (method === "GET" && p) {
    const result = await upstream(
      `${ROBLOX.groups}/v1/groups/${p[0]}/roles`
    );
    if (!result.ok) {
      return json(result.data, result.status);
    }
    const roles = result.data?.roles || [];
    return json({
      groupId: Number(p[0]),
      role: roles.find(
        role => Number(role.id) === Number(p[1])
      ) || null,
    });
  }

  p = routeMatch(path, /^\/group-members\/(\d+)$/);
  if (method === "GET" && p) {
    const query = pagination(url, 100, 100);
    return proxy(
      `${ROBLOX.groups}/v1/groups/${p[0]}/users?${query}`
    );
  }

  p = routeMatch(path, /^\/group-role-users\/(\d+)\/(\d+)$/);
  if (method === "GET" && p) {
    const query = pagination(url, 100, 100);
    return proxy(
      `${ROBLOX.groups}/v1/groups/${p[0]}/roles/${p[1]}/users?${query}`
    );
  }

  p = routeMatch(path, /^\/group-member-count\/(\d+)$/);
  if (method === "GET" && p) {
    const result = await upstream(
      `${ROBLOX.groups}/v1/groups/${p[0]}`
    );
    if (!result.ok) {
      return json(result.data, result.status);
    }
    return json({
      groupId: Number(p[0]),
      memberCount: result.data.memberCount ?? null,
    });
  }

  p = routeMatch(path, /^\/group-games\/(\d+)$/);
  if (method === "GET" && p) {
    const query = pagination(url, 50, 50);
    query.set(
      "accessFilter",
      url.searchParams.get("accessFilter") || "Public"
    );
    return proxy(
      `${ROBLOX.games}/v2/groups/${p[0]}/games?${query}`
    );
  }

  if (method === "POST" && path === "/presence/users") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({
        ok: false,
        error: "Request body must be valid JSON.",
      }, 400);
    }
    const userIds = Array.isArray(body?.userIds)
      ? body.userIds
          .map(Number)
          .filter(id => Number.isSafeInteger(id) && id > 0)
          .slice(0, 50)
      : [];
    if (!userIds.length) {
      return json({
        ok: false,
        error: "Provide userIds.",
      }, 400);
    }
    return proxy(
      `${ROBLOX.presence}/v1/presence/users`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ userIds }),
      }
    );
  }

  p = routeMatch(path, /^\/user-badges\/(\d+)$/);
  if (method === "GET" && p) {
    const query = pagination(url, 50, 100);
    return proxy(
      `${ROBLOX.badges}/v1/users/${p[0]}/badges?${query}`
    );
  }

  p = routeMatch(path, /^\/badge\/(\d+)$/);
  if (method === "GET" && p) {
    return proxy(
      `${ROBLOX.badges}/v1/badges/${p[0]}`
    );
  }

  p = routeMatch(path, /^\/collectibles\/(\d+)$/);
  if (method === "GET" && p) {
    const query = pagination(url, 100, 100);
    return proxy(
      `${ROBLOX.economy}/v2/users/${p[0]}/assets/collectibles?${query}`
    );
  }

  p = routeMatch(path, /^\/inventory\/(\d+)$/);
  if (method === "GET" && p) {
    const query = pagination(url, 50, 100);
    const assetType = url.searchParams.get("assetType");
    if (assetType && validId(assetType)) {
      query.set("assetType", assetType);
    }
    return proxy(
      `${ROBLOX.inventory}/v1/users/${p[0]}/assets/collectibles?${query}`
    );
  }

  p = routeMatch(path, /^\/user-games\/(\d+)$/);
  if (method === "GET" && p) {
    const query = pagination(url, 50, 50);
    query.set("accessFilter", "Public");
    return proxy(
      `${ROBLOX.games}/v2/users/${p[0]}/games?${query}`
    );
  }

  p = routeMatch(path, /^\/user-favorites\/(\d+)$/);
  if (method === "GET" && p) {
    const query = pagination(url, 50, 50);
    query.set("accessFilter", "Public");
    return proxy(
      `${ROBLOX.games}/v2/users/${p[0]}/favorite/games?${query}`
    );
  }

  p = routeMatch(path, /^\/games-info\/([0-9,]+)$/);
  if (method === "GET" && p) {
    const ids = numericIds(p[0], 100);
    if (!ids.length) {
      return json({ data: [] }, 400);
    }
    return proxy(
      `${ROBLOX.games}/v1/games?universeIds=${ids.join(",")}`
    );
  }

  p = routeMatch(path, /^\/game-details\/(\d+)$/);
  if (method === "GET" && p) {
    return proxy(
      `${ROBLOX.games}/v1/games?universeIds=${p[0]}`
    );
  }

  p = routeMatch(path, /^\/game-votes\/(\d+)$/);
  if (method === "GET" && p) {
    return proxy(
      `${ROBLOX.games}/v1/games/${p[0]}/votes`
    );
  }

  p = routeMatch(path, /^\/game-servers\/(\d+)$/);
  if (method === "GET" && p) {
    const query = pagination(url, 25, 100);
    return proxy(
      `${ROBLOX.games}/v1/games/${p[0]}/servers/Public?${query}`
    );
  }

  p = routeMatch(path, /^\/game-icon\/(\d+)$/);
  if (method === "GET" && p) {
    const query = new URLSearchParams({
      universeIds: p[0],
      size: url.searchParams.get("size") || "512x512",
      format: "Png",
    });
    return proxy(
      `${ROBLOX.thumbnails}/v1/games/icons?${query}`
    );
  }

  p = routeMatch(path, /^\/game-thumbnails\/(\d+)$/);
  if (method === "GET" && p) {
    const query = new URLSearchParams({
      universeIds: p[0],
      count: String(asInt(
        url.searchParams.get("count"),
        10,
        1,
        50
      )),
      size: url.searchParams.get("size") || "768x432",
      format: "Png",
      isCircular: "false",
    });
    return proxy(
      `${ROBLOX.thumbnails}/v1/games/multiget/thumbnails?${query}`
    );
  }

  p = routeMatch(path, /^\/catalog-search\/([^/]+)\/(.*)$/);
  if (method === "GET" && p) {
    const query = new URLSearchParams({
      category: p[0],
      keyword: p[1],
      limit: String(getLimit(url, 30, 120)),
      sortType: url.searchParams.get("sortType") || "Relevance",
    });
    const subcategory = url.searchParams.get("subcategory");
    if (subcategory) {
      query.set("subcategory", subcategory);
    }
    return proxy(
      `${ROBLOX.catalog}/v1/search/items?${query}`
    );
  }

  p = routeMatch(path, /^\/catalog-item\/(\d+)$/);
  if (method === "GET" && p) {
    return proxy(
      `${ROBLOX.catalog}/v1/catalog/items/details`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          items: [{
            itemType: "Asset",
            id: Number(p[0]),
          }],
        }),
      }
    );
  }

  p = routeMatch(path, /^\/asset-bundles\/(\d+)$/);
  if (method === "GET" && p) {
    return proxy(
      `${ROBLOX.catalog}/v1/assets/${p[0]}/bundles?sortOrder=Asc`
    );
  }

  p = routeMatch(path, /^\/bundle-details\/(\d+)$/);
  if (method === "GET" && p) {
    return proxy(
      `${ROBLOX.catalog}/v1/bundles/${p[0]}/details`
    );
  }

  p = routeMatch(path, /^\/limited-resale\/(\d+)$/);
  if (method === "GET" && p) {
    return proxy(
      `${ROBLOX.economy}/v1/assets/${p[0]}/resale-data`
    );
  }

  p = routeMatch(path, /^\/group-store\/([^/]+)\/(\d+)$/);
  if (method === "GET" && p) {
    const query = new URLSearchParams({
      category: p[0],
      creatorTargetId: p[1],
      creatorType: "Group",
      limit: String(getLimit(url, 30, 120)),
      sortType: url.searchParams.get("sortType") || "Relevance",
    });
    return proxy(
      `${ROBLOX.catalog}/v1/search/items?${query}`
    );
  }

  p = routeMatch(path, /^\/group-store-keyword\/([^/]+)\/(.*)$/);
  if (method === "GET" && p) {
    const query = new URLSearchParams({
      category: p[0],
      keyword: p[1],
      limit: String(getLimit(url, 30, 120)),
      sortType: url.searchParams.get("sortType") || "Relevance",
    });
    const groupId = url.searchParams.get("groupId");
    if (groupId && validId(groupId)) {
      query.set("creatorTargetId", groupId);
      query.set("creatorType", "Group");
    }
    return proxy(
      `${ROBLOX.catalog}/v1/search/items?${query}`
    );
  }

  // ── ROLIMONS ──────────────────────────────────────────────────────────────
  p = routeMatch(path, /^\/rolimons-player\/(\d+)$/);
  if (method === "GET" && p) {
    return proxy(
      `${ROLIMONS}/players/v1/playerinfo/${p[0]}`
    );
  }

  if (method === "GET" && path === "/rolimons-items") {
    return proxy(
      `${ROLIMONS}/items/v1/itemdetails`
    );
  }

  // ── FULL PROFILE ──────────────────────────────────────────────────────────
  p = routeMatch(path, /^\/full-profile\/(\d+)$/);
  if (method === "GET" && p) {
    const userId = p[0];
    const sections = {
      profile:
        () => rz(getUsersUserid, { userId: Number(userId) }, `${ROBLOX.users}/v1/users/${userId}`),
      avatar:
        `${ROBLOX.avatar}/v1/users/${userId}/avatar`,
      wearing:
        `${ROBLOX.avatar}/v1/users/${userId}/currently-wearing`,
      outfits:
        `${ROBLOX.avatar}/v2/avatar/users/${userId}/outfits?itemsPerPage=50&isEditable=false`,
      usernameHistory:
        () => rz(getUsersUseridUsernameHistory, { userId: Number(userId), limit: 100 }, `${ROBLOX.users}/v1/users/${userId}/username-history?limit=100`),
      groups:
        `${ROBLOX.groups}/v2/users/${userId}/groups/roles`,
      friendsCount:
        () => rz(getUsersUseridFriendsCount, { userId: Number(userId) }, `${ROBLOX.friends}/v1/users/${userId}/friends/count`),
      followersCount:
        () => rz(getUsersTargetuseridFollowersCount, { targetUserId: Number(userId) }, `${ROBLOX.friends}/v1/users/${userId}/followers/count`),
      followingCount:
        () => rz(getUsersTargetuseridFollowingsCount, { targetUserId: Number(userId) }, `${ROBLOX.friends}/v1/users/${userId}/followings/count`),
      badges:
        `${ROBLOX.badges}/v1/users/${userId}/badges?limit=50&sortOrder=Asc`,
    };

    const requested = url.searchParams.get("sections");
    if (requested) {
      const selected = requested
        .split(",")
        .map(value => value.trim());
      for (const key of Object.keys(sections)) {
        if (!selected.includes(key)) {
          delete sections[key];
        }
      }
    }

    const profile = await aggregate(sections);
    return json({
      ok: true,
      userId: Number(userId),
      sections: profile,
    });
  }

  return json({
    ok: false,
    error: "Unknown endpoint",
    path,
    documentation: "/",
  }, 404);
}

export default {
  async fetch(request, env, ctx) {
    robloxCookie = env && env.ROBLOX_COOKIE ? String(env.ROBLOX_COOKIE).trim() : "";
    try {
      return await handle(request);
    } catch (error) {
      return json({
        ok: false,
        error: "Worker internal error",
        details: String(error),
      }, 500);
    }
  },
};
