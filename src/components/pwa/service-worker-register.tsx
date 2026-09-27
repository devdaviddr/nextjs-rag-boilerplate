'use client'

import { useEffect } from 'react'

/**
 * Registers the service worker on the client. Uses `updateViaCache: 'none'`
 * so the browser always revalidates /sw.js and users pick up new versions.
 * When a new SW is waiting, it is activated and the page reloaded once.
 *
 * With the PWA switched off (`PWA_ENABLED=false`, #140) it unregisters any
 * worker a browser kept from before, or switching it off would never reach
 * the people who already had it.
 */
export function ServiceWorkerRegister({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (!('serviceWorker' in navigator)) return

    if (!enabled) {
      void navigator.serviceWorker
        .getRegistrations()
        .then((registrations) =>
          Promise.all(registrations.map((r) => r.unregister())),
        )
      return
    }

    // Only reload when an *updated* worker takes over — not on the first
    // install's initial claim (which would reload the page on first visit and
    // can race in-flight navigations like sign-out).
    const hadController = !!navigator.serviceWorker.controller
    let refreshing = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing || !hadController) return
      refreshing = true
      window.location.reload()
    })

    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((registration) => {
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing
          if (!installing) return
          installing.addEventListener('statechange', () => {
            // A new SW is installed while an old one still controls the page.
            if (
              installing.state === 'installed' &&
              navigator.serviceWorker.controller
            ) {
              registration.waiting?.postMessage('SKIP_WAITING')
            }
          })
        })
      })
      .catch((error) => {
        console.error('Service worker registration failed:', error)
      })
  }, [enabled])

  return null
}
