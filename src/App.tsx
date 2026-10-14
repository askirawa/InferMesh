import { useState } from 'react'
import Layout from './components/Layout'
import Dashboard from './components/Dashboard'
import Marketplace from './components/Marketplace'
import Playground from './components/Playground'
import UsageHistory from './components/UsageHistory'
import WalletPage from './components/WalletPage'

type Page = 'dashboard' | 'marketplace' | 'playground' | 'usage' | 'wallet'

export default function App() {
  const [page, setPage] = useState<Page>('dashboard')
  const [playgroundModel, setPlaygroundModel] = useState<string | undefined>()

  function goToPlayground(modelId: string) {
    setPlaygroundModel(modelId)
    setPage('playground')
  }

  return (
    <Layout page={page} onNavigate={setPage}>
      {page === 'dashboard' && <Dashboard onNavigate={setPage} />}
      {page === 'marketplace' && <Marketplace onSelectModel={goToPlayground} />}
      {page === 'playground' && <Playground initialModel={playgroundModel} />}
      {page === 'usage' && <UsageHistory />}
      {page === 'wallet' && <WalletPage />}
    </Layout>
  )
}
