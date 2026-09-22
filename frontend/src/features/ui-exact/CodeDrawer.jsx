import { useState } from 'react'


const LANGS = ['cURL', 'JavaScript', 'Node', 'Python']

function generateCode(lang, method, url) {
  const urlStr = url || 'https://api.example.com/v1/orders'
  if (lang === 'cURL') {
    return `curl --request ${method} \\
  '${urlStr}' \\
  --header 'Accept: application/json' \\
  --header 'Authorization: Bearer {{orders_token}}'`
  }
  if (lang === 'JavaScript') {
    return `const response = await fetch('${urlStr}', {
  method: '${method}',
  headers,
});

const data = await response.json();
console.log(data);`
  }
  if (lang === 'Node') {
    return `const https = require('https');

const options = {
  method: '${method}',
  headers: {
    'Accept': 'application/json',
    'Authorization': \`Bearer \${process.env.ORDERS_TOKEN}\`,
  },
};

https.get('${urlStr}', options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => console.log(JSON.parse(body)));
});`
  }
  return `import requests

response = requests.${method.toLowerCase()}(
    '${urlStr}',
    headers={
        'Accept': 'application/json',
        'Authorization': f'Bearer {orders_token}',
    }
)

print(response.json())`
}

export default function CodeDrawer({ method, url, onClose }) {
  const [lang, setLang] = useState('cURL')
  const [copied, setCopied] = useState(false)
  const code = generateCode(lang, method, url)

  const copy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 200 }} />
      <div
        className="slide-in-right"
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 400,
          background: 'var(--panel)',
          borderLeft: '1px solid var(--border)',
          zIndex: 201,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Code</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>

        {/* Language list */}
        <div style={{ borderBottom: '1px solid var(--border)', padding: '8px 0' }}>
          {LANGS.map(l => (
            <button
              key={l}
              onClick={() => setLang(l)}
              style={{
                width: '100%',
                padding: '7px 16px',
                background === l ? 'var(--panel-2)' : 'transparent',
                border: 'none',
                color === l ? 'var(--text)' : 'var(--text-muted)',
                cursor: 'pointer',
                textAlign: 'left',
                fontSize: 12,
                borderLeft === l ? '2px solid var(--accent)' : '2px solid transparent',
              }}
            >
              {l}
            </button>
          ))}
        </div>

        {/* Code block */}
        <div style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
          <button
            onClick={copy}
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              padding: '4px 10px',
              background: 'var(--panel-2)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: copied ? 'var(--status-2xx)' : 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 11,
              zIndex: 1,
            }}
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
          <pre style={{
            margin: 0,
            padding: '16px',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            lineHeight: 1.65,
            color: 'var(--text)',
            whiteSpace: 'pre-wrap',
          }}>
            {code}
          </pre>
        </div>
      </div>
    </>
  )
}
