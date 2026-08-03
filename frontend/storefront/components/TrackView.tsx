'use client'

import { useEffect } from 'react'

// Счётчик просмотров: бекон в Next route handler /t (инкремент в Redis).
// На GET витрины никаких записей в PG — только Redis.
export function TrackView({ shopId, albumId }: { shopId: string; albumId?: string }) {
  useEffect(() => {
    try {
      const body = JSON.stringify({ shop_id: shopId, album_id: albumId })
      navigator.sendBeacon('/t', new Blob([body], { type: 'application/json' }))
    } catch {
      // Аналитика не должна ломать страницу.
    }
  }, [shopId, albumId])
  return null
}
