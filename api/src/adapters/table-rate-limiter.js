const { createHash } = require("node:crypto");

const { ApiError } = require("../domain/api-error");

const PARTITION_KEY = "gallery-chat";
const MAX_RETRIES = 8;

function fixedWindow(nowMilliseconds, durationMilliseconds) {
  return Math.floor(nowMilliseconds / durationMilliseconds);
}

function clientKey(clientIp) {
  return createHash("sha256").update(clientIp).digest("hex");
}

function createTableRateLimiter({ tableClient, now = Date.now }) {
  if (
    typeof tableClient?.getEntity !== "function" ||
    typeof tableClient?.createEntity !== "function" ||
    typeof tableClient?.updateEntity !== "function"
  ) {
    throw new TypeError("tableClient must provide getEntity, createEntity, and updateEntity.");
  }

  return Object.freeze({
    async consume(clientIp) {
      if (typeof clientIp !== "string" || clientIp.trim() === "") {
        throw new ApiError(400, "CLIENT_IP_REQUIRED", "Client address is required.");
      }

      const rowKey = clientKey(clientIp.trim());
      for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
        const currentTime = now();
        const minuteWindow = fixedWindow(currentTime, 60_000);
        const dayWindow = fixedWindow(currentTime, 86_400_000);
        let entity;

        try {
          entity = await tableClient.getEntity(PARTITION_KEY, rowKey);
        } catch (error) {
          if (error?.statusCode !== 404) throw error;
          entity = { partitionKey: PARTITION_KEY, rowKey };
        }

        const minuteCount = entity.minuteWindow === minuteWindow ? Number(entity.minuteCount ?? 0) : 0;
        const dayCount = entity.dayWindow === dayWindow ? Number(entity.dayCount ?? 0) : 0;
        if (minuteCount >= 20 || dayCount >= 200) {
          throw new ApiError(429, "RATE_LIMIT_EXCEEDED", "Too many chat requests.");
        }

        const nextEntity = {
          partitionKey: PARTITION_KEY,
          rowKey,
          minuteWindow,
          minuteCount: minuteCount + 1,
          dayWindow,
          dayCount: dayCount + 1,
        };

        try {
          if (entity.etag) {
            await tableClient.updateEntity(nextEntity, "Replace", { etag: entity.etag });
          } else {
            await tableClient.createEntity(nextEntity);
          }
          return;
        } catch (error) {
          if (error?.statusCode !== 409 && error?.statusCode !== 412) throw error;
        }
      }

      throw new ApiError(503, "RATE_LIMIT_UNAVAILABLE", "Chat request accounting is unavailable.");
    },
  });
}

module.exports = { createTableRateLimiter };