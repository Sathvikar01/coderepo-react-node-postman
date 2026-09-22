
export const collections = [
  {
    id: 'orders-api',
    title: 'Orders API',
    expanded: true,
    folders: [
      {
        id: 'orders-read',
        title: 'Read',
        expanded: true,
        items: [
          { id: 'list-orders', title: 'List orders', method: 'GET', url: 'https://api.example.com/v1/orders', params: [
            { id: 'p1', enabled: true, key: 'status', value: 'paid' },
            { id: 'p2', enabled: false, key: 'limit', value: '20' },
          ]},
          { id: 'get-order', title: 'Get order', method: 'GET', url: 'https://api.example.com/v1/orders/:id' },
        ],
      },
      {
        id: 'orders-write',
        title: 'Write',
        expanded: true,
        items: [
          { id: 'create-order', title: 'Create order', method: 'POST', url: 'https://api.example.com/v1/orders' },
          { id: 'update-order', title: 'Update order', method: 'PATCH', url: 'https://api.example.com/v1/orders/:id' },
          { id: 'delete-order', title: 'Delete order', method: 'DELETE', url: 'https://api.example.com/v1/orders/:id' },
        ],
      },
    ],
  },
  {
    id: 'http-examples',
    title: 'HTTP Examples',
    expanded: false,
    folders: [
      {
        id: 'http-get',
        title: 'GET requests',
        expanded: false,
        items: [
          { id: 'http-get-json', title: 'JSON response', method: 'GET', url: 'https://httpbin.org/json' },
          { id: 'http-get-delay', title: 'Delayed response', method: 'GET', url: 'https://httpbin.org/delay/2' },
        ],
      },
    ],
  },
]

export const historyEntries = [
  { id: 'h1', status: 200, method: 'GET', path: '/v1/orders', fullUrl: 'https://api.example.com/v1/orders', ms: 118, env: 'Local', time: '10:42 PM', collection: 'Orders API' },
  { id: 'h2', status: 401, method: 'GET', path: '/v1/orders', fullUrl: 'https://api.example.com/v1/orders', ms: 31, env: 'Local', time: '10:39 PM' },
  { id: 'h3', status: 404, method: 'GET', path: '/v1/orders/9999', fullUrl: 'https://api.example.com/v1/orders/9999', ms: 26, env: 'Local', time: '10:31 PM', collection: 'Orders API' },
  { id: 'h4', status: 201, method: 'POST', path: '/v1/orders', fullUrl: 'https://api.example.com/v1/orders', ms: 204, env: 'Local', time: '10:18 PM', collection: 'Orders API' },
  { id: 'h5', status: 422, method: 'POST', path: '/v1/orders', fullUrl: 'https://api.example.com/v1/orders', ms: 45, env: 'Staging', time: '9:55 PM' },
]

export const environments = [
  {
    id: 'local',
    name: 'Local',
    variables: [
      { id: 'v1', name: 'base_url', type: 'plain', value: 'http://127.0.0.1:3000' },
      { id: 'v2', name: 'customer_name', type: 'plain', value: 'Ada' },
      { id: 'v3', name: 'orders_token', type: 'secret', value: 'sk_local_3xbq8nv2p' },
    ],
  },
  {
    id: 'staging',
    name: 'Staging',
    variables: [
      { id: 'v4', name: 'base_url', type: 'plain', value: 'https://staging.example.com' },
      { id: 'v5', name: 'customer_name', type: 'plain', value: 'Ada' },
      { id: 'v6', name: 'orders_token', type: 'secret', value: 'sk_staging_9kp2mhw7z' },
    ],
  },
]

export const recorderExecutions = [
  { id: 'r1', status: 401, method: 'GET', path: '/v1/orders', time: '10:39 PM', success: false },
  { id: 'r2', status: 200, method: 'GET', path: '/v1/orders', time: '10:37 PM', success: true },
  { id: 'r3', status: 200, method: 'GET', path: '/v1/orders/42', time: '10:22 PM', success: true },
]

export const defaultTabs = [
  {
    id: 'tab-list-orders',
    title: 'List orders',
    method: 'GET',
    url: 'https://api.example.com/v1/orders',
    dirty: false,
    collectionPath: 'Orders API / Read',
    collectionId: 'list-orders',
  },
  {
    id: 'tab-scratch',
    title: 'Scratch',
    method: 'GET',
    url: '',
    dirty: false,
  },
]
