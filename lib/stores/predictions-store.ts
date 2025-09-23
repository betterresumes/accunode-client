'use client'

import { create } from 'zustand'
import { predictionsApi } from '@/lib/api/predictions'
import { dashboardApi } from '@/lib/api/dashboard'
import { organizationsApi } from '@/lib/api/organizations'
import { useAuthStore } from '@/lib/stores/auth-store'

interface Prediction {
  // Core identification
  id: string
  company_id: string
  company_symbol: string
  company_name: string

  // Reporting period
  reporting_year: string
  reporting_quarter?: string

  // Financial ratios (different names than expected)
  long_term_debt_to_total_capital?: number
  total_debt_to_ebitda?: number
  net_income_margin?: number
  ebit_to_interest_expense?: number
  return_on_assets?: number
  sga_margin?: number
  return_on_capital?: number

  // Probability fields (multiple types)
  probability?: number // Annual predictions
  logistic_probability?: number // Quarterly predictions
  gbm_probability?: number // Quarterly predictions  
  ensemble_probability?: number // Quarterly predictions
  default_probability?: number // Computed field for backward compatibility

  // Risk assessment
  risk_level: string // "LOW", "MEDIUM", "HIGH"
  risk_category?: string // Backward compatibility
  confidence: number

  // Organization and access
  organization_id?: string | null
  organization_name?: string | null
  organization_access: string // "personal" | "organization" | "system" (simplified from backend)

  // Audit fields
  created_by: string
  created_by_email?: string
  created_at: string

  // Legacy fields for backward compatibility
  sector?: string
  model_type?: string
  model_version?: string
  updated_at?: string
}

interface PredictionsState {
  // ROLE-BASED USER DATA (backend already filters correctly based on user role):
  // - Normal user: personal predictions only
  // - Org admin/member: organization predictions only  
  // - Tenant admin: tenant-scoped predictions only
  annualPredictions: Prediction[]
  quarterlyPredictions: Prediction[]

  // SYSTEM/PLATFORM DATA (same for all roles)
  systemAnnualPredictions: Prediction[]
  systemQuarterlyPredictions: Prediction[]

  isLoading: boolean
  error: string | null
  lastFetched: number | null
  isInitialized: boolean
  isFetching: boolean

  // Legacy pagination for backward compatibility
  // Separate pagination for user and system data
  annualPagination: {
    currentPage: number
    totalPages: number
    totalItems: number
    pageSize: number
    hasMore: boolean
  }
  quarterlyPagination: {
    currentPage: number
    totalPages: number
    totalItems: number
    pageSize: number
    hasMore: boolean
  }
  systemAnnualPagination: {
    currentPage: number
    totalPages: number
    totalItems: number
    pageSize: number
    hasMore: boolean
  }
  systemQuarterlyPagination: {
    currentPage: number
    totalPages: number
    totalItems: number
    pageSize: number
    hasMore: boolean
  }

  // Data access filter state  
  activeDataFilter: string // 'personal', 'organization', 'system', or 'all' for viewing
}

type PredictionsStore = PredictionsState & {
  // Actions
  fetchPredictions: (forceRefresh?: boolean) => Promise<void>
  refetchPredictions: () => Promise<void>
  clearError: () => void
  reset: () => void
  invalidateCache: () => void
  addPrediction: (prediction: Prediction, type: 'annual' | 'quarterly') => void
  replacePrediction: (prediction: Prediction, type: 'annual' | 'quarterly', tempId: string) => void
  removePrediction: (predictionId: string, type: 'annual' | 'quarterly') => void
  setDataFilter: (filter: string) => void
  getDefaultFilterForUser: (user: any) => string

  // Helper method for processing predictions data  
  processAllPredictionsData: (
    userAnnualResponse: any,
    userQuarterlyResponse: any,
    systemAnnualResponse: any,
    systemQuarterlyResponse: any,
    user: any
  ) => Promise<{
    transformedUserAnnual: Prediction[]
    transformedUserQuarterly: Prediction[]
    transformedSystemAnnual: Prediction[]
    transformedSystemQuarterly: Prediction[]
  }>

  // Utility functions
  getPredictionProbability: (prediction: Prediction) => number
  getRiskBadgeColor: (riskLevel: string | undefined | null) => string
  formatPredictionDate: (prediction: Prediction) => string
  getFilteredPredictions: (type: 'annual' | 'quarterly') => Prediction[]
}

export const usePredictionsStore = create<PredictionsStore>((set, get) => {
  // Set up minimal event listeners - avoid automatic fetching
  if (typeof window !== 'undefined') {
    // Only listen for logout to clear data
    window.addEventListener('auth-logout', () => {
      console.log('🔓 Logout detected - clearing prediction data')
      get().reset()
    })
  }

  return {
    annualPredictions: [],
    quarterlyPredictions: [],
    systemAnnualPredictions: [],
    systemQuarterlyPredictions: [],
    isLoading: false,
    error: null,
    lastFetched: null,
    isInitialized: false,
    isFetching: false,
    activeDataFilter: 'personal', // Initial filter (updated based on user role after login)

    // Legacy server-side pagination
    // User data pagination - fetch smaller amounts for user-specific data
    annualPagination: {
      currentPage: 1,
      totalPages: 0,
      totalItems: 0,
      pageSize: 100, // Smaller size for user data
      hasMore: false
    },
    quarterlyPagination: {
      currentPage: 1,
      totalPages: 0,
      totalItems: 0,
      pageSize: 100, // Smaller size for user data
      hasMore: false
    },

    // System data pagination - fetch more for comprehensive platform view
    systemAnnualPagination: {
      currentPage: 1,
      totalPages: 0,
      totalItems: 0,
      pageSize: 100, // Initial load for system data
      hasMore: false
    },
    systemQuarterlyPagination: {
      currentPage: 1,
      totalPages: 0,
      totalItems: 0,
      pageSize: 100, // Initial load for system data
      hasMore: false
    },

    fetchPredictions: async (forceRefresh = false) => {
      const state = get()

      console.log('🚀 fetchPredictions called:', {
        forceRefresh,
        isFetching: state.isFetching,
        isInitialized: state.isInitialized,
        hasAnnual: state.annualPredictions.length,
        hasQuarterly: state.quarterlyPredictions.length,
        hasSystemAnnual: state.systemAnnualPredictions.length,
        hasSystemQuarterly: state.systemQuarterlyPredictions.length,
        lastFetched: state.lastFetched ? new Date(state.lastFetched).toISOString() : 'never'
      })

      // Prevent multiple simultaneous calls
      if (state.isFetching) {
        console.log('📦 Predictions already being fetched - skipping duplicate call')
        return
      }

      // Don't fetch if we already have recent data and app is initialized, unless forcing refresh
      if (!forceRefresh && state.isInitialized && state.lastFetched && Date.now() - state.lastFetched < 30 * 60 * 1000) {
        console.log('📋 Using cached predictions data (less than 30 min old) - no API call needed')
        return
      }

      // Get current user from auth store
      const authStore = useAuthStore.getState()
      const user = authStore.user

      if (!user) {
        set({
          isLoading: false,
          error: 'User not authenticated',
          isFetching: false
        })
        return
      }

      console.log('👤 Fetching predictions for user role:', user.role)
      set({ isLoading: true, error: null, isFetching: true })

      try {
        const { annualPagination, quarterlyPagination, systemAnnualPagination, systemQuarterlyPagination } = state

        // FIXED: Different API calls based on user role
        if (user.role === 'super_admin') {
          // Super admin: ONLY system data, no user data
          console.log('🌐 Super admin - fetching ONLY system predictions (2 API calls)')
          const [
            systemAnnualResponse,
            systemQuarterlyResponse
          ] = await Promise.all([
            predictionsApi.annual.getSystemAnnualPredictions({
              page: systemAnnualPagination.currentPage,
              size: systemAnnualPagination.pageSize
            }),
            predictionsApi.quarterly.getSystemQuarterlyPredictions({
              page: systemQuarterlyPagination.currentPage,
              size: systemQuarterlyPagination.pageSize
            })
          ])

          // Process system data only
          const systemAnnualData = systemAnnualResponse?.data?.items || systemAnnualResponse?.data?.predictions || systemAnnualResponse?.data || []
          const systemAnnualMeta = systemAnnualResponse?.data

          const systemQuarterlyData = systemQuarterlyResponse?.data?.items || systemQuarterlyResponse?.data?.predictions || systemQuarterlyResponse?.data || []
          const systemQuarterlyMeta = systemQuarterlyResponse?.data

          // Transform system predictions
          const transformedSystemAnnual = Array.isArray(systemAnnualData) ? systemAnnualData.map((pred: any) => ({
            ...pred,
            default_probability: pred.probability || 0,
            risk_category: pred.risk_level,
            reporting_year: pred.reporting_year?.toString() || new Date().getFullYear().toString(),
            organization_access: 'system',
            financial_ratios: {
              ltdtc: pred.long_term_debt_to_total_capital,
              roa: pred.return_on_assets,
              ebitint: pred.ebit_to_interest_expense
            }
          })) : []

          const transformedSystemQuarterly = Array.isArray(systemQuarterlyData) ? systemQuarterlyData.map((pred: any) => ({
            ...pred,
            default_probability: pred.logistic_probability || 0,
            risk_category: pred.risk_level,
            reporting_year: pred.reporting_year?.toString() || new Date().getFullYear().toString(),
            reporting_quarter: pred.reporting_quarter?.toUpperCase() || "Q1",
            organization_access: 'system',
            financial_ratios: {
              ltdtc: pred.long_term_debt_to_total_capital,
              sga: pred.sga_margin,
              roa: pred.return_on_capital,
              tdte: pred.total_debt_to_ebitda
            }
          })) : []

          console.log('✅ Super admin data loaded:', {
            systemAnnual: transformedSystemAnnual.length,
            systemQuarterly: transformedSystemQuarterly.length
          })

          console.log('🔍 Super admin sample annual data:', transformedSystemAnnual.slice(0, 3).map((p: any) => ({
            id: p.id,
            company: p.company_symbol,
            access: p.organization_access,
            risk_level: p.risk_level,
            probability: p.default_probability
          })))

          console.log('🔍 Super admin sample quarterly data:', transformedSystemQuarterly.slice(0, 3).map((p: any) => ({
            id: p.id,
            company: p.company_symbol,
            access: p.organization_access,
            risk_level: p.risk_level,
            probability: p.default_probability
          })))

          set({
            // Super admin gets NO user data
            annualPredictions: [],
            quarterlyPredictions: [],
            // Only system data
            systemAnnualPredictions: transformedSystemAnnual,
            systemQuarterlyPredictions: transformedSystemQuarterly,
            isLoading: false,
            error: null,
            lastFetched: Date.now(),
            isInitialized: true,
            isFetching: false,
            activeDataFilter: 'system', // Force system filter for super admin
            systemAnnualPagination: {
              currentPage: 1,
              totalPages: systemAnnualMeta?.pages || 1,
              totalItems: systemAnnualMeta?.total || transformedSystemAnnual.length,
              pageSize: systemAnnualPagination.pageSize,
              hasMore: 1 < (systemAnnualMeta?.pages || 1)
            },
            systemQuarterlyPagination: {
              currentPage: 1,
              totalPages: systemQuarterlyMeta?.pages || 1,
              totalItems: systemQuarterlyMeta?.total || transformedSystemQuarterly.length,
              pageSize: systemQuarterlyPagination.pageSize,
              hasMore: 1 < (systemQuarterlyMeta?.pages || 1)
            }
          })

          // Double check: Ensure the filter is definitely set to system for super admin
          console.log('🔒 Final super admin state check:', {
            activeDataFilter: get().activeDataFilter,
            systemAnnualCount: get().systemAnnualPredictions.length,
            systemQuarterlyCount: get().systemQuarterlyPredictions.length
          })

        } else {
          // All other users: 4 API calls (user data + system data)
          console.log('🌐 Regular user - fetching both user and system predictions (4 API calls)')
          const [
            userAnnualResponse,
            userQuarterlyResponse,
            systemAnnualResponse,
            systemQuarterlyResponse
          ] = await Promise.all([
            // User role-based predictions (excludes system data)
            predictionsApi.annual.getAnnualPredictions({
              page: annualPagination.currentPage,
              size: annualPagination.pageSize
            }),
            predictionsApi.quarterly.getQuarterlyPredictions({
              page: quarterlyPagination.currentPage,
              size: quarterlyPagination.pageSize
            }),
            // System predictions (platform-wide data)
            predictionsApi.annual.getSystemAnnualPredictions({
              page: systemAnnualPagination.currentPage,
              size: systemAnnualPagination.pageSize
            }),
            predictionsApi.quarterly.getSystemQuarterlyPredictions({
              page: systemQuarterlyPagination.currentPage,
              size: systemQuarterlyPagination.pageSize
            })
          ])

          // Process user data with proper organization access mapping
          const { transformedUserAnnual, transformedUserQuarterly, transformedSystemAnnual, transformedSystemQuarterly } =
            await get().processAllPredictionsData(
              userAnnualResponse, userQuarterlyResponse,
              systemAnnualResponse, systemQuarterlyResponse,
              user
            )

          // Set initial data filter based on user role
          const initialFilter = get().getDefaultFilterForUser(user)

          set({
            annualPredictions: transformedUserAnnual,
            quarterlyPredictions: transformedUserQuarterly,
            systemAnnualPredictions: transformedSystemAnnual,
            systemQuarterlyPredictions: transformedSystemQuarterly,
            isLoading: false,
            error: null,
            lastFetched: Date.now(),
            isInitialized: true,
            isFetching: false,
            activeDataFilter: initialFilter,
            // Update user pagination
            annualPagination: {
              currentPage: 1,
              totalPages: userAnnualResponse?.data?.pages || 1,
              totalItems: userAnnualResponse?.data?.total || transformedUserAnnual.length,
              pageSize: annualPagination.pageSize,
              hasMore: 1 < (userAnnualResponse?.data?.pages || 1)
            },
            quarterlyPagination: {
              currentPage: 1,
              totalPages: userQuarterlyResponse?.data?.pages || 1,
              totalItems: userQuarterlyResponse?.data?.total || transformedUserQuarterly.length,
              pageSize: quarterlyPagination.pageSize,
              hasMore: 1 < (userQuarterlyResponse?.data?.pages || 1)
            },
            // Update system pagination
            systemAnnualPagination: {
              currentPage: 1,
              totalPages: systemAnnualResponse?.data?.pages || 1,
              totalItems: systemAnnualResponse?.data?.total || transformedSystemAnnual.length,
              pageSize: systemAnnualPagination.pageSize,
              hasMore: 1 < (systemAnnualResponse?.data?.pages || 1)
            },
            systemQuarterlyPagination: {
              currentPage: 1,
              totalPages: systemQuarterlyResponse?.data?.pages || 1,
              totalItems: systemQuarterlyResponse?.data?.total || transformedSystemQuarterly.length,
              pageSize: systemQuarterlyPagination.pageSize,
              hasMore: 1 < (systemQuarterlyResponse?.data?.pages || 1)
            }
          })
        }

      } catch (error) {
        console.error('Failed to fetch predictions:', error)
        const isAuthError = (error as any)?.response?.status === 401 || (error as any)?.message?.includes('unauthorized')

        if (isAuthError) {
          console.log('🔒 Auth error detected - keeping existing data, will retry after token refresh')
          set({
            isLoading: false,
            error: null,
            isFetching: false
          })
        } else {
          set({
            isLoading: false,
            error: (error as any)?.message || 'Failed to fetch predictions',
            isFetching: false
          })
        }
      }
    },

    // Helper method to process all predictions data for non-super-admin users
    processAllPredictionsData: async (
      userAnnualResponse: any,
      userQuarterlyResponse: any,
      systemAnnualResponse: any,
      systemQuarterlyResponse: any,
      user: any
    ) => {
      console.log('🎯 Processing predictions data for user role:', user.role)

      // Process user annual predictions
      const userAnnualData = userAnnualResponse?.data?.items || userAnnualResponse?.data?.predictions || userAnnualResponse?.data || []
      const userQuarterlyData = userQuarterlyResponse?.data?.items || userQuarterlyResponse?.data?.predictions || userQuarterlyResponse?.data || []
      const systemAnnualData = systemAnnualResponse?.data?.items || systemAnnualResponse?.data?.predictions || systemAnnualResponse?.data || []
      const systemQuarterlyData = systemQuarterlyResponse?.data?.items || systemQuarterlyResponse?.data?.predictions || systemQuarterlyResponse?.data || []

      console.log('📊 Raw data processing results:', {
        userAnnual: userAnnualData.length,
        userQuarterly: userQuarterlyData.length,
        systemAnnual: systemAnnualData.length,
        systemQuarterly: systemQuarterlyData.length
      })

      // Debug: Log sample of each data type
      console.log('🔍 Sample userAnnual data:', userAnnualData.slice(0, 2).map((p: any) => ({
        company: p.company_symbol,
        access: p.access_level,
        org_id: p.organization_id,
        created_by: p.created_by
      })))

      console.log('🔍 Sample systemAnnual data:', systemAnnualData.slice(0, 2).map((p: any) => ({
        company: p.company_symbol,
        access: p.access_level,
        org_id: p.organization_id,
        created_by: p.created_by
      })))

      // Transform user annual predictions - SIMPLIFIED: Trust backend role-based filtering
      const transformedUserAnnual = Array.isArray(userAnnualData) ? userAnnualData.map((pred: any) => {
        console.log('🔍 Processing user annual prediction:', {
          company: pred.company_symbol,
          userRole: user.role,
          backendAccessLevel: pred.access_level
        })

        // SIMPLIFIED: Trust backend to provide correct role-based data
        // Backend APIs already filter based on user role:
        // - Normal user: gets personal predictions
        // - Org admin/member: gets organization predictions  
        // - Tenant admin: gets tenant-scoped predictions
        const organization_access = pred.access_level || pred.organization_access ||
          (user.role === 'org_admin' || user.role === 'org_member' ? 'organization' : 'personal')

        console.log(`   ✅ Using access level: ${organization_access}`)

        return {
          ...pred,
          default_probability: pred.probability || 0,
          risk_category: pred.risk_level,
          reporting_year: pred.reporting_year?.toString() || new Date().getFullYear().toString(),
          organization_access,
          financial_ratios: {
            ltdtc: pred.long_term_debt_to_total_capital,
            roa: pred.return_on_assets,
            ebitint: pred.ebit_to_interest_expense
          }
        }
      }) : []

      // Transform user quarterly predictions - SIMPLIFIED: Trust backend role-based filtering
      const transformedUserQuarterly = Array.isArray(userQuarterlyData) ? userQuarterlyData.map((pred: any) => {
        console.log('🔍 Processing user quarterly prediction:', {
          company: pred.company_symbol,
          userRole: user.role,
          backendAccessLevel: pred.access_level
        })

        // SIMPLIFIED: Trust backend to provide correct role-based data
        const organization_access = pred.access_level || pred.organization_access ||
          (user.role === 'org_admin' || user.role === 'org_member' ? 'organization' : 'personal')

        console.log(`   ✅ Using access level: ${organization_access}`)

        return {
          ...pred,
          default_probability: pred.logistic_probability || 0,
          risk_category: pred.risk_level,
          reporting_year: pred.reporting_year?.toString() || new Date().getFullYear().toString(),
          reporting_quarter: pred.reporting_quarter?.toUpperCase() || "Q1",
          organization_access,
          financial_ratios: {
            ltdtc: pred.long_term_debt_to_total_capital,
            sga: pred.sga_margin,
            roa: pred.return_on_capital,
            tdte: pred.total_debt_to_ebitda
          }
        }
      }) : []

      // Transform system annual predictions - always 'system' access
      const transformedSystemAnnual = Array.isArray(systemAnnualData) ? systemAnnualData.map((pred: any) => ({
        ...pred,
        default_probability: pred.probability || 0,
        risk_category: pred.risk_level,
        reporting_year: pred.reporting_year?.toString() || new Date().getFullYear().toString(),
        organization_access: 'system', // Always system for these predictions
        financial_ratios: {
          ltdtc: pred.long_term_debt_to_total_capital,
          roa: pred.return_on_assets,
          ebitint: pred.ebit_to_interest_expense
        }
      })) : []

      // Transform system quarterly predictions - always 'system' access
      const transformedSystemQuarterly = Array.isArray(systemQuarterlyData) ? systemQuarterlyData.map((pred: any) => ({
        ...pred,
        default_probability: pred.logistic_probability || 0,
        risk_category: pred.risk_level,
        reporting_year: pred.reporting_year?.toString() || new Date().getFullYear().toString(),
        reporting_quarter: pred.reporting_quarter?.toUpperCase() || "Q1",
        organization_access: 'system', // Always system for these predictions
        financial_ratios: {
          ltdtc: pred.long_term_debt_to_total_capital,
          sga: pred.sga_margin,
          roa: pred.return_on_capital,
          tdte: pred.total_debt_to_ebitda
        }
      })) : []

      console.log('✅ Transformed predictions:', {
        userAnnual: transformedUserAnnual.length,
        userQuarterly: transformedUserQuarterly.length,
        systemAnnual: transformedSystemAnnual.length,
        systemQuarterly: transformedSystemQuarterly.length
      })

      console.log('🔍 User Annual access breakdown:', transformedUserAnnual.reduce((acc: any, p) => {
        acc[p.organization_access] = (acc[p.organization_access] || 0) + 1
        return acc
      }, {}))

      console.log('🔍 User Annual sample:', transformedUserAnnual.slice(0, 3).map((p: any) => ({
        company: p.company_symbol,
        access: p.organization_access,
        org_id: p.organization_id,
        created_by: p.created_by
      })))

      console.log('🔍 System Annual sample:', transformedSystemAnnual.slice(0, 3).map((p: any) => ({
        company: p.company_symbol,
        access: p.organization_access,
        org_id: p.organization_id,
        created_by: p.created_by
      })))

      return {
        transformedUserAnnual,
        transformedUserQuarterly,
        transformedSystemAnnual,
        transformedSystemQuarterly
      }
    },

    // SIMPLIFIED: Trust backend role-based filtering instead of complex client-side filtering
    getFilteredPredictions: (type: 'annual' | 'quarterly') => {
      const state = get()

      console.log(`🔍 FILTERING ${type} predictions:`)
      console.log(`   - activeDataFilter: "${state.activeDataFilter}"`)
      console.log(`   - systemAnnualPredictions count: ${state.systemAnnualPredictions.length}`)
      console.log(`   - systemQuarterlyPredictions count: ${state.systemQuarterlyPredictions.length}`)
      console.log(`   - annualPredictions count: ${state.annualPredictions.length}`)
      console.log(`   - quarterlyPredictions count: ${state.quarterlyPredictions.length}`)

      // Get predictions from appropriate store based on filter
      if (state.activeDataFilter === 'system') {
        // Platform tab: ONLY system/platform predictions
        const systemPredictions = type === 'annual' ? state.systemAnnualPredictions : state.systemQuarterlyPredictions
        console.log(`   🔵 Platform filter: ${systemPredictions.length} system predictions`)
        return systemPredictions
      } else {
        // User tabs: Backend already filtered data correctly based on user role
        // - Normal user: gets personal predictions
        // - Org admin/member: gets organization predictions
        // - Tenant admin: gets tenant-scoped predictions
        const userPredictions = type === 'annual' ? state.annualPredictions : state.quarterlyPredictions

        console.log(`   📋 User predictions (backend filtered): ${userPredictions.length}`)
        console.log(`   📋 Sample user data:`, userPredictions.slice(0, 3).map(p => ({
          company: p.company_symbol,
          access: p.organization_access
        })))

        // Return all user predictions since backend already filtered correctly
        return userPredictions
      }
    },

    getDefaultFilterForUser: (user: any) => {
      if (!user) {
        console.log('🔍 No user, returning default filter: personal')
        return 'personal'
      }
      console.log('🔍 Getting default filter for user role:', user.role)

      // Role-based default filter logic
      switch (user.role) {
        case 'user':
          // Normal user: start with their personal data
          return 'personal'

        case 'super_admin':
          // Super admin: only has platform data
          return 'system'

        case 'org_admin':
        case 'org_member':
          // Org roles: start with organization data (no personal data)
          return 'organization'

        case 'tenant_admin':
          // Tenant admin: start with organization data (manages multiple orgs)
          return 'organization'

        default:
          // Fallback: personal
          return 'personal'
      }
    },

    setDataFilter: (filter: string) => {
      console.log(`🔄 Switching data filter from "${get().activeDataFilter}" to "${filter}"`)
      set({ activeDataFilter: filter })
    },

    // Add prediction to the appropriate store when user creates new prediction
    addPrediction: (prediction: Prediction, type: 'annual' | 'quarterly') => {
      const state = get()
      console.log(`➕ Adding new ${type} prediction to cache:`, prediction.company_symbol)

      if (prediction.organization_access === 'system') {
        // Add to system predictions
        if (type === 'annual') {
          set({
            systemAnnualPredictions: [prediction, ...state.systemAnnualPredictions]
          })
        } else {
          set({
            systemQuarterlyPredictions: [prediction, ...state.systemQuarterlyPredictions]
          })
        }
      } else {
        // Add to user predictions
        if (type === 'annual') {
          set({
            annualPredictions: [prediction, ...state.annualPredictions]
          })
        } else {
          set({
            quarterlyPredictions: [prediction, ...state.quarterlyPredictions]
          })
        }
      }
    },

    // Replace prediction when editing
    replacePrediction: (prediction: Prediction, type: 'annual' | 'quarterly', tempId: string) => {
      const state = get()

      if (prediction.organization_access === 'system') {
        // Replace in system predictions
        if (type === 'annual') {
          set({
            systemAnnualPredictions: state.systemAnnualPredictions.map(p =>
              p.id === tempId ? prediction : p
            )
          })
        } else {
          set({
            systemQuarterlyPredictions: state.systemQuarterlyPredictions.map(p =>
              p.id === tempId ? prediction : p
            )
          })
        }
      } else {
        // Replace in user predictions
        if (type === 'annual') {
          set({
            annualPredictions: state.annualPredictions.map(p =>
              p.id === tempId ? prediction : p
            )
          })
        } else {
          set({
            quarterlyPredictions: state.quarterlyPredictions.map(p =>
              p.id === tempId ? prediction : p
            )
          })
        }
      }
    },

    // Remove prediction from both stores
    removePrediction: (predictionId: string, type: 'annual' | 'quarterly') => {
      const state = get()

      if (type === 'annual') {
        set({
          annualPredictions: state.annualPredictions.filter(p => p.id !== predictionId),
          systemAnnualPredictions: state.systemAnnualPredictions.filter(p => p.id !== predictionId)
        })
      } else {
        set({
          quarterlyPredictions: state.quarterlyPredictions.filter(p => p.id !== predictionId),
          systemQuarterlyPredictions: state.systemQuarterlyPredictions.filter(p => p.id !== predictionId)
        })
      }
    },

    // Utility functions (unchanged)
    getPredictionProbability: (prediction: Prediction) => {
      return prediction.default_probability ||
        prediction.probability ||
        prediction.logistic_probability ||
        prediction.ensemble_probability ||
        0
    },

    getRiskBadgeColor: (riskLevel: string | undefined | null) => {
      switch (riskLevel?.toUpperCase()) {
        case 'LOW':
          return 'bg-green-100 text-green-800 border-green-200'
        case 'MEDIUM':
          return 'bg-yellow-100 text-yellow-800 border-yellow-200'
        case 'HIGH':
          return 'bg-orange-100 text-orange-800 border-orange-200'
        case 'CRITICAL':
          return 'bg-red-100 text-red-800 border-red-200'
        default:
          return 'bg-gray-100 text-gray-800 border-gray-200'
      }
    },

    formatPredictionDate: (prediction: Prediction) => {
      if (prediction.reporting_quarter) {
        return `${prediction.reporting_quarter} ${prediction.reporting_year}`
      }
      return prediction.reporting_year || 'Unknown'
    },

    refetchPredictions: async () => {
      await get().fetchPredictions(true)
    },

    invalidateCache: () => {
      set({
        lastFetched: null,
        isInitialized: false
      })
    },

    clearError: () => set({ error: null }),

    reset: () => set({
      annualPredictions: [],
      quarterlyPredictions: [],
      systemAnnualPredictions: [],
      systemQuarterlyPredictions: [],
      isLoading: false,
      error: null,
      lastFetched: null,
      isInitialized: false,
      isFetching: false,
      activeDataFilter: 'personal', // Reset to initial state (updated on next login)

      annualPagination: {
        currentPage: 1,
        totalPages: 0,
        totalItems: 0,
        pageSize: 100,
        hasMore: false
      },
      quarterlyPagination: {
        currentPage: 1,
        totalPages: 0,
        totalItems: 0,
        pageSize: 100,
        hasMore: false
      },
      systemAnnualPagination: {
        currentPage: 1,
        totalPages: 0,
        totalItems: 0,
        pageSize: 100,
        hasMore: false
      },
      systemQuarterlyPagination: {
        currentPage: 1,
        totalPages: 0,
        totalItems: 0,
        pageSize: 100,
        hasMore: false
      }
    })
  }
})
