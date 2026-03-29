import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Landing, Dashboard, MyBets, History, MarketDetail, Settings, Governance, CreateMarketPage, TermsOfService, PrivacyPolicy, RiskDisclosure, CookiesPolicy, HowItWorks, FAQ, APIDocs, BrandKit, BugBounty } from './pages'
import { initializeMarketIds } from './lib/aleo-client'
import { ErrorBoundary } from './components/ErrorBoundary'
import { MobileNav } from './components/MobileNav'

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

        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/portfolio" element={<MyBets />} />
        <Route path="/history" element={<History />} />
        <Route path="/market/:marketId" element={<MarketDetail />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/governance" element={<Governance />} />
        <Route path="/create" element={<CreateMarketPage />} />

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
