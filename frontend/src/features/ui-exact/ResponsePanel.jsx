import { useState } from 'react'


const TABS = [
  { id: 'pretty', label: 'Pretty' },
  { id: 'raw', label: 'Raw' },
  { id: 'headers', label: 'Headers' },
  { id: 'cookies', label: 'Cookies' },
  { id: 'tests', label: 'Tests' },
]

const mockResponse = `{
  "data": [
    {
      "id": "ord_1Hk2Xm",
      "status": "paid",
      "customer": "Ada",
      "amount": 4200,
      "currency": "usd",
      "created_at": "2024-01-15T22:41:00Z",
      "items": [
        { "sku": "ORD-001", "qty": 2, "price": 2100 }
      ]
    },
    {
      "id": "ord_2Lp9Qr",
      "status": "paid",
      "customer": "Ada",
      "amount": 1800,
      "currency": "usd",
      "created_at": "2024-01-14T18:22:00Z",
      "items": [
        { "sku": "ORD-002", "qty": 1, "price": 1800 }
      ]
    }
  ],
  "meta": {
    "total": 2,
    "page": 1,
    "per_page": 20
  }
}`

const mockHeaders = [
  { key: 'Content-Type', value: 'application/json; charset=utf-8' },
  { key: 'X-Request-Id', value: 'req_4nBqKp2Xm' },
  { key: 'Cache-Control', value: 'no-cache' },
  { key: 'X-Rate-Limit', value: '1000' },
  { key: 'X-Rate-Remaining', value: '997' },
]

function StatusBadge({ status }) {
  const color = status >= 200 && status < 300 ? 'var(--status-2xx)' : status >= 400 ? 'var(--status-4xx)' : 'var(--status-5xx)'
  const label = status === 200 ? '200 OK'  === 401 ? '401 Unauthorized' : `${status}`
  return (
    <span style={{
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 12,
      fontWeight: 500,
      color,
      background: `${color}18`,
      padding: '3px 8px',
      borderRadius: 4,
    }}>
      {label}
    </span>
  )
}


export default function ResponsePanel({ sent, onSaveExample }) {
  const [activeTab, setActiveTab] = useState('pretty')

  if (!sent) {
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 8,
        color: 'var(--text-dim)',
        background: 'var(--surface)',
      }}>
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none" opacity={0.4}>
          <path d="M6 18h4M26 18h4M18 6v4M18 26v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          <circle cx="18" cy="18" r="8" stroke="currentColor" strokeWidth="2"/>
          <path d="M14 18h8M18 14v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        <span style={{ fontSize: 13 }}>Send a request to see the response</span>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--surface)' }}>
      {/* Status bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '8px 16px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <StatusBadge status={200} />
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-muted)' }}>118 ms</span>
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-muted)' }}>2.4 KB</span>
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-dim)' }}>HTTP/1.1</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={onSaveExample}
          style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 10px', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}
        >
          Save Example
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '7px 14px',
              border: 'none',
              borderBottom === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
              background: 'transparent',
              color === tab.id ? 'var(--text)' : 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight === tab.id ? 500 : 400,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {(activeTab === 'pretty' || activeTab === 'raw') && (
          <pre style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            lineHeight: 1.65,
            color: 'var(--text)',
            margin: 0,
            whiteSpace: 'pre-wrap',
          }}>
            {mockResponse}
          </pre>
        )}
        {activeTab === 'headers' && (
          <div>
            {mockHeaders.map(h => (
              <div key={h.key} style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 12, padding: '5px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-muted)' }}>{h.key}</span>
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text)' }}>{h.value}</span>
              </div>
            ))}
          </div>
        )}
        {activeTab === 'cookies' && (
          <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>No cookies in this response.</div>
        )}
        {activeTab === 'tests' && (
          <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>No tests defined for this request.</div>
        )}
      </div>
    </div>
  )
}
