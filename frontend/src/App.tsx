import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Landing, Dashboard, MyBets, History, MarketDetail, Settings, Governance, CreateMarketPage, TermsOfService, PrivacyPolicy, RiskDisclosure, CookiesPolicy, HowItWorks, FAQ, APIDocs, BrandKit, BugBounty } from './pages'
// initializeMarketIds removed — market IDs are now managed on-chain via Ethereum events
const initializeMarketIds = async () => { /* no-op on Ethereum */ }
import { ErrorBoundary } from './components/ErrorBoundary'
import { MobileNav } from './components/MobileNav'
import { ProtectedRoute } from './components/ProtectedRoute'

function App() {
  // Initialize market IDs from indexer on app startup
  useEffect(() => {
    initializeMarketIds().catch(console.error);
  }, []);

  return (
    <ErrorBoundary>
      <Routes>
        {/* Landing Page - shown when not connected */}
        <Route path="/" element={<Landing />} />

        <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/portfolio" element={<ProtectedRoute><MyBets /></ProtectedRoute>} />
        <Route path="/history" element={<ProtectedRoute><History /></ProtectedRoute>} />
        <Route path="/market/:marketId" element={<ProtectedRoute><MarketDetail /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
        <Route path="/governance" element={<ProtectedRoute><Governance /></ProtectedRoute>} />
        <Route path="/create" element={<ProtectedRoute><CreateMarketPage /></ProtectedRoute>} />

        {/* Resource Pages */}
        <Route path="/how-it-works" element={<HowItWorks />} />
        <Route path="/faq" element={<FAQ />} />
        <Route path="/api-docs" element={<APIDocs />} />
        <Route path="/brand-kit" element={<BrandKit />} />
        <Route path="/bug-bounty" element={<BugBounty />} />

        {/* Legal Pages */}
        <Route path="/terms" element={<TermsOfService />} />
        <Route path="/privacy" element={<PrivacyPolicy />} />
        <Route path="/risk-disclosure" element={<RiskDisclosure />} />
        <Route path="/cookies" element={<CookiesPolicy />} />

        {/* Catch all - redirect to landing */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {/* Mobile bottom navigation — hidden on md+ */}
      <MobileNav />
    </ErrorBoundary>
  )
}

export default App
