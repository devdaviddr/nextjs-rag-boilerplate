'use client'

import { createContext, useContext } from 'react'

/**
 * Optional areas a deployment can switch off with an environment variable
 * (#140). Read on the server by the dashboard layout and handed to the shell,
 * so client components can hide what would otherwise link to a 404.
 */
export interface Features {
  /** `OBSERVABILITY_UI_ENABLED`: the admin Observability pages. */
  observability: boolean
}

const FeaturesContext = createContext<Features>({ observability: true })

export const FeaturesProvider = FeaturesContext.Provider

export function useFeatures(): Features {
  return useContext(FeaturesContext)
}
