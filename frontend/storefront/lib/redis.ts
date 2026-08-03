import Redis from 'ioredis'

// Singleton-клиент Redis для route handlers (счётчики просмотров).
// Offline queue включена (иначе события в момент установки соединения
// теряются); maxRetriesPerRequest=1 не даёт очереди расти при лежащем
// Redis — команды быстро отклоняются, аналитика теряется молча.
declare global {
  var __redis: Redis | undefined
}

export function getRedis(): Redis {
  if (!globalThis.__redis) {
    globalThis.__redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
    })
    globalThis.__redis.on('error', () => {
      // Ошибки соединения не должны валить процесс (default handler кидает).
    })
  }
  return globalThis.__redis
}
