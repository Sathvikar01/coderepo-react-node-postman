import { useState, useCallback } from 'react'
import { defaultTabs } from './data'
import IconRail from './IconRail'
import CollectionsSidebar from './CollectionsSidebar'
import HistorySidebar from './HistorySidebar'
import RequestTabs from './RequestTabs'
import RequestPane from './RequestPane'
import FlightRecorderMain from './FlightRecorderMain'
import RunnerView from './RunnerView'
import SettingsView from './SettingsView'

let tabCounter = 100

export default function Shell() {
  const [rail, setRail] = useState('collections')
  const [tabs, setTabs] = useState(defaultTabs)
  const [activeTabId, setActiveTabId] = useState(defaultTabs[0].id)
  const [selectedHistory, setSelectedHistory] = useState()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0]

  const openRequest = useCallback((req, col) => {
    const existingTab = tabs.find(t => t.collectionId === req.id)
    if (existingTab) {
      setActiveTabId(existingTab.id)
      return
    }
    const newTab = {
      id: `tab-${++tabCounter}`,
      title: req.title,
      method: req.method,
      url: req.url,
      dirty: false,
      collectionPath: `${col.title} / ${req.title}`,
      collectionId: req.id,
    }
    setTabs(ts => [...ts, newTab])
    setActiveTabId(newTab.id)
    setRail('collections')
  }, [tabs])

  const closeTab = useCallback((id) => {
    const tab = tabs.find(t => t.id === id)
    if (tab?.dirty && !confirm('Close unsaved changes?')) return
    setTabs(ts => {
      const remaining = ts.filter(t => t.id !== id)
      if (remaining.length === 0) return ts
      if (activeTabId === id) setActiveTabId(remaining[remaining.length - 1].id)
      return remaining
    })
  }, [tabs, activeTabId])

  const newTab = useCallback(() => {
    const tab = {
      id: `tab-${++tabCounter}`,
      title: 'New Request',
      method: 'GET',
      url: '',
      dirty: false,
    }
    setTabs(ts => [...ts, tab])
    setActiveTabId(tab.id)
  }, [])

  const updateTab = useCallback((updates) => {
    setTabs(ts => ts.map(t => t.id === activeTabId ? { ...t, ...updates } : t))
  }, [activeTabId])

  const showRequestWorkspace = rail !== 'runner' && rail !== 'settings' && rail !== 'recorder'

  const sidebar = (
    <div style={{
      width: 260,
      background: 'var(--surface)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      overflow: 'hidden',
    }}>
      {rail === 'collections' && <CollectionsSidebar onOpenRequest={openRequest} />}
      {rail === 'history' && <HistorySidebar onSelect={setSelectedHistory} selectedId={selectedHistory?.id} />}
      {/* recorder has its own 2-column layout in main, no sidebar needed */}
      {rail === 'runner' && (
        <div style={{ padding: '12px', color: 'var(--text-muted)', fontSize: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 8 }}>Runner</div>
          <div style={{ color: 'var(--text-dim)' }}>Saved collections appear here</div>
        </div>
      )}
      {rail === 'settings' && (
        <div style={{ padding: '12px', color: 'var(--text-muted)', fontSize: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 10 }}>Settings</div>
          {['Environments', 'Cookies', 'Local Runtime', 'Preferences'].map(item => (
            <button key={item} style={{ width: '100%', padding: '7px 8px', background: item === 'Environments' ? 'var(--panel)' : 'transparent', border: 'none', borderLeft: item === 'Environments' ? '2px solid var(--accent)' : '2px solid transparent', color: item === 'Environments' ? 'var(--text)' : 'var(--text-muted)', cursor: 'pointer', textAlign: 'left', fontSize: 12, borderRadius: 2 }}>
              {item}
            </button>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <div style={{
      display: 'flex',
      height: '100vh',
      background: 'var(--bg)',
      overflow: 'hidden',
    }}>
      {/* Icon rail — always visible on desktop */}
      <div style={{ display: 'flex' }} className="desktop-rail">
        <IconRail active={rail} onSelect={setRail} />
      </div>

      {/* Sidebar — hidden on mobile and when recorder is active */}
      {rail !== 'recorder' && (
        <div className="desktop-sidebar" style={{ display: 'flex' }}>
          {sidebar}
        </div>
      )}

      {/* Main workspace */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {/* Top bar */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 16px',
          height: 44,
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
          flexShrink: 0,
        }}>
          {/* Mobile menu button */}
          <button
            className="mobile-menu-btn"
            onClick={() => setSidebarOpen(true)}
            style={{ display: 'none', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4, marginRight: 4 }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2 4h14M2 9h14M2 14h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>

          {/* Logo (mobile) */}
          <div className="mobile-logo" style={{ display: 'none', width: 24, height: 24, background: 'var(--accent)', borderRadius: 4, alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, fontSize: 11, color: 'var(--accent-fg)' }}>T</span>
          </div>

          {/* Search */}
          <div style={{ flex: 1, maxWidth: 320, position: 'relative' }}>
            <svg style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M8.5 8.5l2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            <input
              placeholder="Search / Command…"
              style={{
                width: '100%',
                padding: '5px 8px 5px 26px',
                background: 'var(--panel)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--text)',
                fontSize: 12,
                outline: 'none',
              }}
            />
          </div>

          <div style={{ flex: 1 }} />

          {/* ENV badge */}
          <button style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 10px',
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 5,
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 500,
          }}>
            <span>ENV
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>

          {/* Theme toggle placeholder */}
          <button style={{ width: 30, height: 30, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6 }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
          </button>

          {/* Profile */}
          <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--panel-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>A</span>
          </div>
        </div>

        {/* Workspace content */}
        {rail === 'runner' && (
          <div style={{ flex: 1, overflowY: 'auto', background: 'var(--surface)' }}>
            <RunnerView />
          </div>
        )}

        {rail === 'settings' && (
          <div style={{ flex: 1, overflow: 'hidden', background: 'var(--surface)' }}>
            <SettingsView />
          </div>
        )}

        {rail === 'recorder' && (
          <div style={{ flex: 1, overflow: 'hidden', background: 'var(--surface)' }}>
            <FlightRecorderMain />
          </div>
        )}

        {showRequestWorkspace && (
          <>
            <RequestTabs
              tabs={tabs}
              activeId={activeTabId}
              onSelect={setActiveTabId}
              onClose={closeTab}
              onNew={newTab}
            />
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {activeTab && (
                <RequestPane key={activeTabId} tab={activeTab} onUpdate={updateTab} />
              )}
            </div>
          </>
        )}
      </div>

      {/* Mobile overlay sidebar */}
      {sidebarOpen && (
        <>
          <div onClick={() => setSidebarOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 300 }} />
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            bottom: 0,
            width: 280,
            background: 'var(--surface)',
            zIndex: 301,
            display: 'flex',
            flexDirection: 'column',
            borderRight: '1px solid var(--border)',
          }}
          className="slide-in-right"
          >
            <div style={{ display: 'flex', padding: '8px', gap: 4, borderBottom: '1px solid var(--border)' }}>
              {[
                { id: 'collections', icon: '◉' },
                { id: 'history', icon: '◷' },
                { id: 'runner', icon: '▶' },
                { id: 'recorder', icon: '◈' },
                { id: 'settings', icon: '⚙' },
              ].map(item => (
                <button key={item.id} onClick={() => setRail(item.id)} style={{
                  flex: 1,
                  height: 36,
                  borderRadius: 6,
                  border: 'none',
                  background: rail === item.id ? 'var(--panel)' : 'transparent',
                  color: rail === item.id ? 'var(--accent)' : 'var(--text-muted)',
                  cursor: 'pointer',
                  fontSize: 14,
                }}>
                  {item.icon}
                </button>
              ))}
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {rail === 'collections' && <CollectionsSidebar onOpenRequest={(req, col) => { openRequest(req, col); setSidebarOpen(false) }} />}
              {rail === 'history' && <HistorySidebar onSelect={e => { setSelectedHistory(e); setSidebarOpen(false) }} selectedId={selectedHistory?.id} />}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
