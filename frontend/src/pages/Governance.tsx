// ============================================================================
// FHENIX GOVERNANCE — Premium Layout
// ============================================================================

import { motion } from 'framer-motion';
import { Users, Vote, Gavel, Building, FileText, Plus } from 'lucide-react';
import { FHENIX_GOVERNANCE_ADDRESS } from '../lib/contracts';
import { DashboardHeader } from '../components/DashboardHeader';
import { Footer } from '../components/Footer';

export function Governance() {

  // === COMING SOON LAYOUT — governance handlers will be wired when UI is ready ===

  return (
    <div className="min-h-screen bg-surface-950 flex flex-col">
      <DashboardHeader />

      <main className="flex-1 pt-24 lg:pt-28 pb-20 flex items-center justify-center">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 text-center">

          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <div className="w-20 h-20 rounded-2xl bg-brand-500/10 flex items-center justify-center mx-auto mb-6">
              <Building className="w-10 h-10 text-brand-400" />
            </div>
            <h1 className="font-display text-[2.5rem] leading-[1.1] tracking-tight text-white mb-3">Governance</h1>
            <p className="text-xl text-surface-400 mb-6">Coming Soon</p>
            <p className="text-surface-500 text-sm max-w-md mx-auto mb-8">
              On-chain governance with ETH staking, proposal voting, resolver registry, and treasury management is being finalized. The governance contract is already deployed on testnet.
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-w-lg mx-auto mb-8">
              {[
                { label: 'Proposal Voting', icon: Vote },
                { label: 'ETH Staking', icon: Gavel },
                { label: 'Resolver Registry', icon: Users },
                { label: 'Treasury Multisig', icon: Building },
                { label: 'Vote Delegation', icon: FileText },
                { label: 'Reward Epochs', icon: Plus },
              ].map((item) => (
                <div key={item.label} className="flex items-center gap-2 p-3 rounded-xl bg-white/[0.02] border border-white/[0.04]">
                  <item.icon className="w-4 h-4 text-brand-400 flex-shrink-0" />
                  <span className="text-xs text-surface-400">{item.label}</span>
                </div>
              ))}
            </div>

            <p className="text-[10px] text-surface-600 font-mono">
              Contract: {FHENIX_GOVERNANCE_ADDRESS}
            </p>
          </motion.div>

        </div>
      </main>

      <Footer />
    </div>
  );
}
