const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(cors()); // 첫번째 미들웨어
app.use(express.json()); // 두번쨰 미들웨어 - 요청에서 JSON으로 req.body 파싱

const SECRET = 'szg-shop-secret-key';
const PORT = process.env.PORT || 3000;

// ---- Fake DB: 상품 ----
const products = Array.from({ length: 50 }).map((_, i) => ({
  id: i + 1,
  name: `상품 ${i + 1}`,
  price: (i + 1) * 1000,
  stock: 100,
}));

// ---- Fake DB: 장바구니 (유저별, 메모리 저장) ----
const carts = new Map(); // username -> [{productId, qty}]

// ---- 교육용 DB Connection Pool 병목 시뮬레이션 ----
// 주문(결제) API는 동시에 MAX_POOL개까지만 처리 가능하게 제한.
// 부하가 이 값을 넘으면 대기가 발생 -> 응답시간이 급격히 늘어나는 걸 실습에서 관찰 가능.
const MAX_POOL = 8;
let activeConnections = 0;
const waitQueue = [];

function acquireConnection() {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (activeConnections < MAX_POOL) {   // 풀에 자리 있으면 바로 통과
        activeConnections++; 
        resolve();
      } else {
        waitQueue.push(tryAcquire);  // 자리 없으면 대기열에 등록
      }
    };
    tryAcquire();
  });
}

function releaseConnection() { // 자리 반납 + 대기자 깨우기
  activeConnections--;
  const next = waitQueue.shift(); // 대기열 맨 앞 사람
  if (next) next(); // 그 사람한테 자리 넘겨주기
}

// ---- JWT 인증 미들웨어 ----
function authenticate(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'no token' });
  }
  try {
    const payload = jwt.verify(auth.split(' ')[1], SECRET);
    req.user = payload.username;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
}

// ---- 헬스체크 ----
app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeConnections, waiting: waitQueue.length });
});

// ---- 로그인 ----
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username/password required' });
  }
  // 데모용: 아무 계정이나 허용 (실서비스라면 DB 조회 + 비밀번호 검증)
  const token = jwt.sign({ username }, SECRET, { expiresIn: '1h' });
  res.json({ token, username });
});

// ---- 상품 목록 ----
app.get('/api/products', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const size = parseInt(req.query.size) || 10;
  const start = (page - 1) * size;
  res.json({
    page,
    size,
    total: products.length,
    items: products.slice(start, start + size),
  });
});

// ---- 상품 상세 ----
app.get('/api/products/:id', (req, res) => {
  const product = products.find((p) => p.id === parseInt(req.params.id));
  if (!product) return res.status(404).json({ error: 'not found' });
  res.json(product);
});

// ---- 장바구니 담기 ----
app.post('/api/cart', authenticate, (req, res) => { // authenticate 미들웨어 먼저 통과
  const { productId, qty } = req.body;
  const product = products.find((p) => p.id === productId);
  if (!product) return res.status(404).json({ error: 'product not found' });

  const cart = carts.get(req.user) || []; // ③ 이 유저의 기존 장바구니 꺼내기 (없으면 빈 배열)
  cart.push({ productId, qty: qty || 1 });
  carts.set(req.user, cart);
  res.json({ cart }); // ⑥ 최종 장바구니 응답
});

// ---- 장바구니 조회 ----
app.get('/api/cart', authenticate, (req, res) => {
  res.json({ cart: carts.get(req.user) || [] });
});

// ---- 주문(결제) - 커넥션 풀 병목이 걸리는 구간 ----
app.post('/api/orders', authenticate, async (req, res) => {
  const start = Date.now();

  // ① 커넥션 획득 시도 - 여기서 타임아웃(POOL_TIMEOUT_MS) 넘으면 reject됨
  try {
    await acquireConnection();
  } catch (e) {
    // 풀 자리를 끝내 못 받은 경우 -> 503으로 응답하고 여기서 함수 종료
    return res.status(503).json({ error: 'server busy, connection pool exhausted' });
  }

  // ② 여기부턴 커넥션을 정상적으로 받은 상태라, releaseConnection()을 무조건 보장해야 함
  try {
    // DB 처리 시간 시뮬레이션 (50~150ms)
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    const cart = carts.get(req.user) || [];
    const total = cart.reduce((sum, item) => {
      const p = products.find((pp) => pp.id === item.productId);
      return sum + (p ? p.price * item.qty : 0);
    }, 0);
    carts.set(req.user, []); // 주문 후 장바구니 비움
    res.json({
      orderId: Math.floor(Math.random() * 1000000),
      total,
      processedMs: Date.now() - start,
    });
  } finally {
    releaseConnection();
  }
});

app.listen(PORT, () => {
  console.log(`SZG Shop mock server listening on http://localhost:${PORT}`);
});
