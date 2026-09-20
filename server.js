require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- 数据库初始化与安全读写 ---
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function getInitialDb() {
    const adminSalt = crypto.randomBytes(16).toString('hex');
    const adminHash = hashPassword('admin123456', adminSalt);

    return {
        users: [],
        orders: [],
        admins: [
            {
                id: 'admin_1',
                username: 'admin',
                email: 'admin@rpg.local',
                salt: adminSalt,
                password_hash: adminHash,
                created_at: new Date().toISOString()
            }
        ],
        settings: {
            default_visitor_actions: 15,
            default_general_actions: 25,
            global_api_key: '',
            default_model: 'gemini-2.5-flash',
            custom_proxy_url: '',
            site_notice: '欢迎游玩 AI 文字冒险游戏产生器！新玩家注册即赠送 25 次行动。'
        },
        sessions: {}
    };
}

let dbCache = null;

function loadDb() {
    if (!fs.existsSync(DB_FILE)) {
        dbCache = getInitialDb();
        saveDb();
    } else {
        try {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            dbCache = JSON.parse(data);
        } catch (e) {
            console.error('Failed to parse DB, reinitializing:', e);
            dbCache = getInitialDb();
            saveDb();
        }
    }
    return dbCache;
}

function saveDb() {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbCache, null, 2), 'utf8');
}

loadDb();

// --- 辅助工具函数 ---
function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 10 * 1024 * 1024) { // 10MB limit
                reject(new Error('Payload too large'));
            }
        });
        req.on('end', () => {
            if (!body.trim()) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key'
    });
    res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
    sendJson(res, statusCode, { success: false, error: message });
}

function getAuthUser(req) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    const session = dbCache.sessions[token];
    if (!session) return null;

    if (session.type === 'user') {
        const user = dbCache.users.find(u => u.id === session.userId);
        return user ? { ...user, token } : null;
    }
    return null;
}

function ensureFullWorldState(playerState) {
    if (!playerState) return;
    if (!playerState.world_state) {
        playerState.world_state = {};
    }
    const ws = playerState.world_state;

    // Automatic backfills for safety and retro-compatibility
    if (ws.location === undefined) ws.location = "安全營地 (Safe Camp)";
    if (ws.time === undefined) {
        ws.time = playerState.camp_state?.days !== undefined ? `第 ${playerState.camp_state.days} 天` : "第 1 天";
    }
    if (ws.stamina === undefined) ws.stamina = 100;
    if (ws.max_stamina === undefined) ws.max_stamina = 100;
    if (playerState.stamina === undefined) playerState.stamina = ws.stamina;
    if (playerState.max_stamina === undefined) playerState.max_stamina = ws.max_stamina;
    if (playerState.current_state === undefined) playerState.current_state = 'IDLE';
    if (ws.current_state === undefined) ws.current_state = playerState.current_state;
    if (ws.hunger === undefined) ws.hunger = 100;
    if (ws.hydration === undefined) ws.hydration = 100;
    if (ws.survival_status === undefined) ws.survival_status = (ws.stamina <= 0) ? "EXHAUSTED" : "NORMAL";
    
    if (!ws.resources) {
        ws.resources = { food: 3, water: 3, wood: 3, medicine: 1 };
    } else {
        if (ws.resources.food === undefined) ws.resources.food = 3;
        if (ws.resources.water === undefined) ws.resources.water = 3;
        if (ws.resources.wood === undefined) ws.resources.wood = 3;
        if (ws.resources.medicine === undefined) ws.resources.medicine = 1;
    }

    if (!playerState.camp_state) {
        playerState.camp_state = {
            days: 1,
            chapter: 1,
            shelter_level: 1,
            campfire_lit: true,
            stored_resources: { food: 0, water: 0, wood: 0, medicine: 0 }
        };
    } else {
        if (playerState.camp_state.days === undefined) playerState.camp_state.days = 1;
        if (playerState.camp_state.chapter === undefined) playerState.camp_state.chapter = 1;
        if (playerState.camp_state.shelter_level === undefined) playerState.camp_state.shelter_level = 1;
        if (playerState.camp_state.campfire_lit === undefined) playerState.camp_state.campfire_lit = true;
        if (!playerState.camp_state.stored_resources) playerState.camp_state.stored_resources = { food: 0, water: 0, wood: 0, medicine: 0 };
    }

    if (!playerState.player_status) {
        playerState.player_status = {
            inventory: [],
            currency: 0,
            currency_name: '金幣',
            status_bars: [],
            skills: [],
            equipment: {},
            quests: []
        };
    }
    if (!Array.isArray(playerState.player_status.inventory)) {
        playerState.player_status.inventory = [];
    }
    if (typeof playerState.player_status.currency !== 'number') {
        playerState.player_status.currency = typeof playerState.gold === 'number' ? playerState.gold : 0;
    }
    playerState.gold = playerState.player_status.currency;
    if (!playerState.player_status.currency_name) {
        playerState.player_status.currency_name = '金幣';
    }

    if (ws.inventory === undefined) ws.inventory = playerState.player_status.inventory || [];
    if (ws.npc_state === undefined) ws.npc_state = playerState.npc_state || {};
    if (ws.quests === undefined) ws.quests = [];
    if (ws.intel === undefined) ws.intel = [];
    if (ws.mode === undefined) ws.mode = "自由"; // '剧情' | '自由' | '过渡'
    if (!ws.flags) ws.flags = {};
    if (!ws.decisions) ws.decisions = [];
    if (!ws.npc_favor) ws.npc_favor = {};
}

function isStateRestricted(playerState) {
    if (!playerState) return false;
    const curState = playerState.current_state || playerState.world_state?.current_state;
    if (curState === 'COMBAT' || curState === 'EVENT_LOCKED') return true;
    if (playerState.combat_state || playerState.world_state?.flags?.in_combat || playerState.world_state?.flags?.combat_active) return true;
    return false;
}

function syncNpcFavorToDb(token, npc_favor, npc_state) {
    if (!token) return null;
    if (!dbCache.guest_npc_favors) {
        dbCache.guest_npc_favors = {};
    }
    const session = dbCache.sessions[token];
    if (session && session.type === 'user') {
        const user = dbCache.users.find(u => u.id === session.userId);
        if (user) {
            user.npc_favor = npc_favor || user.npc_favor || {};
            user.npc_state = npc_state || user.npc_state || {};
            saveDb();
            return { npc_favor: user.npc_favor, npc_state: user.npc_state };
        }
    }
    dbCache.guest_npc_favors[token] = dbCache.guest_npc_favors[token] || {};
    if (npc_favor) dbCache.guest_npc_favors[token].npc_favor = npc_favor;
    if (npc_state) dbCache.guest_npc_favors[token].npc_state = npc_state;
    saveDb();
    return dbCache.guest_npc_favors[token];
}

function getAuthAdmin(req) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    const session = dbCache.sessions[token];
    if (!session || session.type !== 'admin') return null;

    const admin = dbCache.admins.find(a => a.id === session.adminId);
    return admin ? { ...admin, token } : null;
}

// --- 静态资源 MIME 类型 ---
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.rpgsave': 'application/octet-stream'
};

// --- HTTP 请求处理器 ---
const server = http.createServer(async (req, res) => {
    // CORS 预检请求
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key'
        });
        return res.end();
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // ==========================================
    // 1. 用户认证路由 (Auth APIs)
    // ==========================================
    if (pathname === '/api/auth/register' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { email, password, nickname, sponsorEmail } = body;

            if (!email || !password) {
                return sendError(res, 400, '邮箱与密码为必填项');
            }
            if (password.length < 6) {
                return sendError(res, 400, '密码长度至少需 6 位');
            }

            const existingUser = dbCache.users.find(u => u.email.toLowerCase() === email.toLowerCase());
            if (existingUser) {
                return sendError(res, 400, '该邮箱已被注册');
            }

            const salt = crypto.randomBytes(16).toString('hex');
            const password_hash = hashPassword(password, salt);
            const newUser = {
                id: 'usr_' + crypto.randomBytes(8).toString('hex'),
                email: email.trim().toLowerCase(),
                nickname: (nickname || email.split('@')[0]).trim(),
                sponsorEmail: '',
                salt,
                password_hash,
                membershipTier: 'sponsor',
                maxActions: Infinity,
                actionsUsed: 0,
                dlc_custom_action: true,
                dlc_cartridge: true,
                created_at: new Date().toISOString()
            };

            dbCache.users.push(newUser);
            const token = generateToken();
            dbCache.sessions[token] = { type: 'user', userId: newUser.id, created_at: Date.now() };
            saveDb();

            const safeUser = { ...newUser };
            delete safeUser.salt;
            delete safeUser.password_hash;
            return sendJson(res, 200, { success: true, token, user: safeUser });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { email, password } = body;

            if (!email || !password) {
                return sendError(res, 400, '请输入邮箱与密码');
            }

            const user = dbCache.users.find(u => u.email.toLowerCase() === email.toLowerCase().trim());
            if (!user) {
                return sendError(res, 401, '账号不存在或密码错误');
            }

            const checkHash = hashPassword(password, user.salt);
            if (checkHash !== user.password_hash) {
                return sendError(res, 401, '账号不存在或密码错误');
            }

            const token = generateToken();
            dbCache.sessions[token] = { type: 'user', userId: user.id, created_at: Date.now() };
            saveDb();

            const safeUser = { ...user };
            delete safeUser.salt;
            delete safeUser.password_hash;
            return sendJson(res, 200, { success: true, token, user: safeUser });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    if (pathname === '/api/auth/me' && req.method === 'GET') {
        const user = getAuthUser(req);
        if (!user) {
            // 游客身份默认权限
            return sendJson(res, 200, {
                success: true,
                isGuest: true,
                user: {
                    membershipTier: 'sponsor',
                    maxActions: Infinity,
                    actionsUsed: 0,
                    dlc_custom_action: true,
                    dlc_cartridge: true
                }
            });
        }
        const safeUser = { ...user };
        delete safeUser.salt;
        delete safeUser.password_hash;
        safeUser.membershipTier = 'sponsor';
        safeUser.maxActions = Infinity;
        safeUser.dlc_custom_action = true;
        safeUser.dlc_cartridge = true;
        return sendJson(res, 200, { success: true, isGuest: false, user: safeUser });
    }

    if (pathname === '/api/auth/action-step' && req.method === 'POST') {
        const user = getAuthUser(req);
        if (user) {
            user.actionsUsed = (user.actionsUsed || 0) + 1;
            saveDb();
            return sendJson(res, 200, { success: true, actionsUsed: user.actionsUsed, maxActions: user.maxActions });
        }
        return sendJson(res, 200, { success: true });
    }

    // ==========================================
    // 2. 赞助提交与核销路由 (Sponsorship APIs)
    // ==========================================
    if (pathname === '/api/sponsor/submit' && req.method === 'POST') {
        try {
            const user = getAuthUser(req);
            const body = await parseJsonBody(req);
            const { sponsorEmail, transactionId, dlcType } = body;

            if (!transactionId || transactionId.trim().length < 6) {
                return sendError(res, 400, '请输入有效的交易单号 (Transaction ID)');
            }

            const cleanTxId = transactionId.trim();
            // 查重：检查该单号是否已经被他人使用
            const existingOrder = dbCache.orders.find(o => o.transaction_id === cleanTxId);
            if (existingOrder && existingOrder.user_id !== (user ? user.id : 'guest')) {
                return sendError(res, 400, '该交易单号已被提交使用');
            }

            const newOrder = {
                id: 'ord_' + crypto.randomBytes(6).toString('hex'),
                user_id: user ? user.id : 'guest',
                user_email: user ? user.email : (sponsorEmail || 'unknown'),
                user_nickname: user ? user.nickname : '游客',
                sponsor_email: (sponsorEmail || (user ? user.sponsorEmail : '')).trim(),
                transaction_id: cleanTxId,
                dlc_type: dlcType || 'sponsor_membership',
                amount: dlcType === 'dlc_both' ? 15 : (dlcType?.startsWith('dlc_') ? 10 : 5),
                status: 'pending', // pending, approved, rejected
                created_at: new Date().toISOString(),
                reviewed_at: null
            };

            if (existingOrder) {
                Object.assign(existingOrder, newOrder);
            } else {
                dbCache.orders.unshift(newOrder);
            }

            // 更新用户自己的 sponsorEmail 记录
            if (user && sponsorEmail) {
                user.sponsorEmail = sponsorEmail.trim();
                user.lastTransactionId = cleanTxId;
            }
            saveDb();

            return sendJson(res, 200, {
                success: true,
                message: '赞助单号已成功提交，管理员将在审核后为您开通！',
                order: newOrder
            });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    if (pathname === '/api/sponsor/status' && req.method === 'GET') {
        const user = getAuthUser(req);
        if (!user) {
            return sendError(res, 401, '请先登录以查看赞助开通状态');
        }

        const approvedOrder = dbCache.orders.find(o => o.user_id === user.id && o.status === 'approved');
        const pendingOrder = dbCache.orders.find(o => o.user_id === user.id && o.status === 'pending');

        return sendJson(res, 200, {
            success: true,
            membershipTier: user.membershipTier,
            maxActions: user.maxActions,
            dlc_custom_action: user.dlc_custom_action,
            dlc_cartridge: user.dlc_cartridge,
            isApproved: user.membershipTier === 'sponsor',
            hasPending: !!pendingOrder,
            pendingOrder: pendingOrder || null
        });
    }

    // ==========================================
    // 3. 运营管理后台路由 (Admin APIs)
    // ==========================================
    if (pathname === '/api/admin/login' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { username, password } = body;

            const admin = dbCache.admins.find(a => a.username === username || a.email === username);
            if (!admin) {
                return sendError(res, 401, '管理员账号或密码错误');
            }

            const checkHash = hashPassword(password, admin.salt);
            if (checkHash !== admin.password_hash) {
                return sendError(res, 401, '管理员账号或密码错误');
            }

            const token = 'adm_' + generateToken();
            dbCache.sessions[token] = { type: 'admin', adminId: admin.id, created_at: Date.now() };
            saveDb();

            return sendJson(res, 200, {
                success: true,
                token,
                admin: { username: admin.username, email: admin.email }
            });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    if (pathname === '/api/admin/stats' && req.method === 'GET') {
        const admin = getAuthAdmin(req);
        if (!admin) return sendError(res, 403, '权限不足，请先登录管理员后台');

        const totalUsers = dbCache.users.length;
        const totalSponsors = dbCache.users.filter(u => u.membershipTier === 'sponsor').length;
        const pendingOrders = dbCache.orders.filter(o => o.status === 'pending').length;
        const totalActions = dbCache.users.reduce((acc, u) => acc + (u.actionsUsed || 0), 0);

        return sendJson(res, 200, {
            success: true,
            stats: {
                totalUsers,
                totalSponsors,
                pendingOrders,
                totalActions,
                totalOrders: dbCache.orders.length
            }
        });
    }

    if (pathname === '/api/admin/orders' && req.method === 'GET') {
        const admin = getAuthAdmin(req);
        if (!admin) return sendError(res, 403, '权限不足');

        const statusFilter = parsedUrl.searchParams.get('status');
        let orders = dbCache.orders;
        if (statusFilter && statusFilter !== 'all') {
            orders = orders.filter(o => o.status === statusFilter);
        }

        return sendJson(res, 200, { success: true, orders });
    }

    if (pathname === '/api/admin/orders/review' && req.method === 'POST') {
        const admin = getAuthAdmin(req);
        if (!admin) return sendError(res, 403, '权限不足');

        try {
            const body = await parseJsonBody(req);
            const { orderId, action, grantTier, grantCustomActionDlc, grantCartridgeDlc } = body;

            const order = dbCache.orders.find(o => o.id === orderId);
            if (!order) return sendError(res, 404, '找不到该赞助工单');

            const targetUser = dbCache.users.find(u => u.id === order.user_id || u.email === order.user_email);

            if (action === 'approve') {
                order.status = 'approved';
                order.reviewed_at = new Date().toISOString();

                if (targetUser) {
                    targetUser.membershipTier = grantTier || 'sponsor';
                    targetUser.maxActions = targetUser.membershipTier === 'sponsor' ? Infinity : 50;
                    if (grantCustomActionDlc !== undefined) targetUser.dlc_custom_action = !!grantCustomActionDlc;
                    if (grantCartridgeDlc !== undefined) targetUser.dlc_cartridge = !!grantCartridgeDlc;
                }
            } else if (action === 'reject') {
                order.status = 'rejected';
                order.reviewed_at = new Date().toISOString();
            } else {
                return sendError(res, 400, '未知操作');
            }

            saveDb();
            return sendJson(res, 200, { success: true, order, targetUser });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    if (pathname === '/api/admin/users' && req.method === 'GET') {
        const admin = getAuthAdmin(req);
        if (!admin) return sendError(res, 403, '权限不足');

        const q = (parsedUrl.searchParams.get('q') || '').toLowerCase().trim();
        let users = dbCache.users;
        if (q) {
            users = users.filter(u => u.email.toLowerCase().includes(q) || u.nickname.toLowerCase().includes(q));
        }

        const safeUsers = users.map(u => {
            const copy = { ...u };
            delete copy.salt;
            delete copy.password_hash;
            return copy;
        });

        return sendJson(res, 200, { success: true, users: safeUsers });
    }

    if (pathname === '/api/admin/users/update' && req.method === 'POST') {
        const admin = getAuthAdmin(req);
        if (!admin) return sendError(res, 403, '权限不足');

        try {
            const body = await parseJsonBody(req);
            const { userId, membershipTier, maxActions, dlc_custom_action, dlc_cartridge } = body;

            const user = dbCache.users.find(u => u.id === userId);
            if (!user) return sendError(res, 404, '未找到该用户');

            if (membershipTier !== undefined) user.membershipTier = membershipTier;
            if (maxActions !== undefined) user.maxActions = maxActions === 'Infinity' ? Infinity : parseInt(maxActions, 10);
            if (dlc_custom_action !== undefined) user.dlc_custom_action = !!dlc_custom_action;
            if (dlc_cartridge !== undefined) user.dlc_cartridge = !!dlc_cartridge;

            saveDb();
            return sendJson(res, 200, { success: true, user });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    if (pathname === '/api/admin/settings' && req.method === 'GET') {
        const admin = getAuthAdmin(req);
        if (!admin) return sendError(res, 403, '权限不足');
        return sendJson(res, 200, { success: true, settings: dbCache.settings });
    }

    if (pathname === '/api/admin/settings' && req.method === 'POST') {
        const admin = getAuthAdmin(req);
        if (!admin) return sendError(res, 403, '权限不足');

        try {
            const body = await parseJsonBody(req);
            Object.assign(dbCache.settings, body);
            saveDb();
            return sendJson(res, 200, { success: true, settings: dbCache.settings });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    // ==========================================
    // 3.2 NPC 好感與狀態同步路由 (NPC Favor Sync)
    // ==========================================
    if (pathname === '/api/npc/sync' && req.method === 'POST') {
        try {
            const authHeader = req.headers['authorization'];
            const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
            if (!token) {
                return sendError(res, 401, 'Unauthorized - Bearer token required');
            }
            const body = await parseJsonBody(req);
            const { npc_favor, npc_state, world_state } = body;
            const synced = syncNpcFavorToDb(token, npc_favor || (world_state && world_state.npc_favor), npc_state);
            return sendJson(res, 200, { success: true, ...synced });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    if (pathname === '/api/npc/sync' && req.method === 'GET') {
        try {
            const authHeader = req.headers['authorization'];
            const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
            if (!token) {
                return sendError(res, 401, 'Unauthorized - Bearer token required');
            }
            if (!dbCache.guest_npc_favors) {
                dbCache.guest_npc_favors = {};
            }
            const session = dbCache.sessions[token];
            if (session && session.type === 'user') {
                const user = dbCache.users.find(u => u.id === session.userId);
                if (user) {
                    return sendJson(res, 200, { success: true, npc_favor: user.npc_favor || {}, npc_state: user.npc_state || {} });
                }
            }
            const guestData = dbCache.guest_npc_favors[token] || { npc_favor: {}, npc_state: {} };
            return sendJson(res, 200, { success: true, npc_favor: guestData.npc_favor || {}, npc_state: guestData.npc_state || {} });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    // ==========================================
    // 3.3 动态反差萌伙伴生成与同步路由 (Dynamic Companion Engine)
    // ==========================================
    if (pathname === '/api/companion/generate' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { genre = 'Post-Apocalyptic', characterDesc = '', language = 'zh-TW', apiKey, model } = body;

            const activeKey = (apiKey || dbCache.settings.global_api_key || process.env.GEMINI_API_KEY || '').trim();
            const activeModel = model || dbCache.settings.default_model || 'gemini-2.5-flash';

            const companionPrompt = `You are an expert game narrative designer specialized in creating endearing, comedic, and charming "Gap-Moe" (反差萌) travel companions for a story-rich Road Trip adventure.
Genre: ${genre}
Player Character: ${characterDesc || 'A wandering traveler'}
Language: ${language === 'zh-TW' ? '繁體中文' : (language === 'ja' ? '日本語' : (language === 'zh-CN' ? '简体中文' : 'English'))}

Generate ONE unique companion who accompanies the player on their journey.
Requirements:
1. **Name**: Memorable nickname/name (e.g. 洛夏, 林檬, 灰羽, 珀莉, 艾可).
2. **Archetype**: Anime/RPG gap-moe archetype (e.g., 搞笑脱线工匠 / 三无冷面近卫 / 傲娇毒舌学者 / 元气治愈游侠 / 贪吃胆小向导).
3. **Visual**: 1 representative Emoji + brief visual signature (e.g., "🎒 大号护目镜与宽大工装短裤").
4. **Personality**: Core traits + 1 distinct everyday slice-of-life gap-moe quirk (e.g., "外冷内热，重度甜食控且极度害怕毛毛虫", "自称机械天才，却经常把扳手当点心咬").
5. **Dialogue Quirk**: Distinctive speaking habit/quirk (e.g., 习惯用数据概率说话、元气满满但经常口误、傲娇吐槽).
6. **Meet Scene**: A comical or warm slice-of-life opening encounter (e.g., 头卡在废弃自动贩卖机里拔不出来、偷偷烤红薯烤焦了在吹气、跟一只机械松鼠认真对峙).
7. **Perk**: { "name": "特技名称", "description": "探索/生活/营地增益效果（如：野炊料理回复翻倍、废墟搜刮额外小玩意、被偷袭概率归零）" }.
8. **Affinity**: Initial value 20.

Respond strictly with valid JSON conforming to this schema (no extra explanation):
\`\`\`json
{
  "name": "string",
  "archetype": "string",
  "visual": "string",
  "personality": "string",
  "dialogue_quirk": "string",
  "meet_scene": "string",
  "perk": {
    "name": "string",
    "description": "string"
  },
  "affinity": 20
}
\`\`\``;

            let companionResult = null;

            if (activeKey) {
                try {
                    let aiText = '';
                    if (activeKey.startsWith('AIzaSy')) {
                        const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${activeKey}`;
                        const response = await fetch(targetUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ contents: [{ parts: [{ text: companionPrompt }] }] })
                        });
                        if (response.ok) {
                            const result = await response.json();
                            aiText = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
                        }
                    } else {
                        const directUrl = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent`;
                        const res = await fetch(directUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': activeKey },
                            body: JSON.stringify({ contents: [{ parts: [{ text: companionPrompt }] }] })
                        });
                        if (res.ok) {
                            const result = await res.json();
                            aiText = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
                        }
                    }

                    if (aiText) {
                        const match = aiText.match(/```json\s*([\s\S]*?)\s*```/) || aiText.match(/\{[\s\S]*\}/);
                        if (match) {
                            companionResult = JSON.parse(match[1] || match[0]);
                        }
                    }
                } catch (err) {
                    console.warn('[Backend] AI companion generation error, using fallback template:', err.message);
                }
            }

            // Fallback templates with rich gap-moe personalities
            if (!companionResult || !companionResult.name) {
                const pool = [
                    {
                        name: "洛夏 (Luoxia)",
                        archetype: "搞笑脱线工匠",
                        visual: "🎒 大号护目镜与工装短裤",
                        personality: "自称万能机械天才，但重度甜食控且极度怕毛毛虫",
                        dialogue_quirk: "每说三句话就要加上「根据本天才的精密测算！」",
                        meet_scene: "脑袋卡在废弃自动贩卖机取物口里正在手忙脚乱地拔不出来，嘴里还咬着半块饼干",
                        perk: { name: "野炊暴击", description: "营地烹饪效果提升50%，搜刮时有概率捡到旧时代的奇妙小玩意" },
                        affinity: 20
                    },
                    {
                        name: "林檬 (Lin Meng)",
                        archetype: "三无冷面近卫",
                        visual: "🗡️ 黑色兜帽与破旧毛绒围巾",
                        personality: "外表冷漠惜字如金，实则是重度毛茸茸控，私底下会对着机械小鸟傻笑",
                        dialogue_quirk: "说话极简短，偶尔认真地蹦出一句完全不好笑的冷笑话",
                        meet_scene: "为了把一只被困在路灯顶端的电子小猫救下来，自己反而挂在半空中进退两难",
                        perk: { name: "警戒雷达", description: "营地休息被夜袭概率降为0，危机时必定替玩家格挡一次关键伤害" },
                        affinity: 20
                    },
                    {
                        name: "灰羽 (Huiyu)",
                        archetype: "傲娇毒舌学者",
                        visual: "📜 金丝单片眼镜与沾满墨水的皮手套",
                        personality: "嘴上喋喋不休抱怨旅途环境糟糕，但每次风吹草动都会第一时间施加防护",
                        dialogue_quirk: "口癖：「真是愚蠢的决定……不过本学者勉为其难原谅你一次」",
                        meet_scene: "为了辨识一株发光的野外奇异蘑菇，以身试毒结果自己舌头麻痹说不出完整的话",
                        perk: { name: "古籍破译", description: "古老遗迹与机械解谜DC判定直接降低3点，能解读古代失落文本" },
                        affinity: 20
                    },
                    {
                        name: "珀莉 (Polly)",
                        archetype: "元气治愈游侠",
                        visual: "🌿 挂满干花的大草帽与旧药箱",
                        personality: "充满无限干劲与乐观，但做饭经常变成充满爆炸声的黑暗料理",
                        dialogue_quirk: "充满朝气的「今天也是闪闪发光的大冒险呢！」",
                        meet_scene: "正在路边跟一只抢走了她烤红薯的变异松鼠进行严肃的“物权归属谈判”",
                        perk: { name: "草药嗅觉", description: "每次野外探索采集到的野果、草药与泉水数量翻倍" },
                        affinity: 20
                    }
                ];
                const selected = pool[Math.floor(Math.random() * pool.length)];
                companionResult = selected;
            }

            // If user has token, auto-persist to user profile
            const authHeader = req.headers['authorization'];
            const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
            if (token) {
                const session = dbCache.sessions[token];
                if (session && session.type === 'user') {
                    const user = dbCache.users.find(u => u.id === session.userId);
                    if (user) {
                        user.active_companion = companionResult;
                        saveDb();
                    }
                } else {
                    if (!dbCache.guest_companions) dbCache.guest_companions = {};
                    dbCache.guest_companions[token] = companionResult;
                    saveDb();
                }
            }

            return sendJson(res, 200, { success: true, companion: companionResult });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    if (pathname === '/api/companion/sync' && req.method === 'POST') {
        try {
            const authHeader = req.headers['authorization'];
            const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
            const body = await parseJsonBody(req);
            const { active_companion } = body;
            
            if (token) {
                const session = dbCache.sessions[token];
                if (session && session.type === 'user') {
                    const user = dbCache.users.find(u => u.id === session.userId);
                    if (user) {
                        user.active_companion = active_companion;
                        saveDb();
                        return sendJson(res, 200, { success: true, active_companion: user.active_companion });
                    }
                }
                if (!dbCache.guest_companions) dbCache.guest_companions = {};
                dbCache.guest_companions[token] = active_companion;
                saveDb();
            }
            return sendJson(res, 200, { success: true, active_companion });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    if (pathname === '/api/companion/sync' && req.method === 'GET') {
        try {
            const authHeader = req.headers['authorization'];
            const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
            if (token) {
                const session = dbCache.sessions[token];
                if (session && session.type === 'user') {
                    const user = dbCache.users.find(u => u.id === session.userId);
                    if (user) {
                        return sendJson(res, 200, { success: true, active_companion: user.active_companion || null });
                    }
                }
                const guestComp = dbCache.guest_companions ? dbCache.guest_companions[token] : null;
                return sendJson(res, 200, { success: true, active_companion: guestComp || null });
            }
            return sendJson(res, 200, { success: true, active_companion: null });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    // ==========================================
    // 3.5 密碼解鎖校驗 (Minigame Verification)
    // ==========================================
    if (pathname === '/api/minigame/verify' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { secretCode, inputCode } = body;
            
            if (typeof secretCode !== 'string' || typeof inputCode !== 'string') {
                return sendError(res, 400, 'Invalid parameters');
            }
            
            const success = (secretCode.trim() === inputCode.trim());
            return sendJson(res, 200, { success });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    // ==========================================
    // 3.6 生存物資與營地休息系統 (Survival & Camping Loop)
    // ==========================================
    if (pathname === '/api/survival/use-resource' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { action, playerState, language } = body;
            if (!playerState) {
                return sendError(res, 400, 'Player state is required');
            }

            ensureFullWorldState(playerState);
            const ws = playerState.world_state;
            const resData = ws.resources;
            const lang = (language || playerState.language || 'zh-TW').toLowerCase();

            let logMessage = '';
            const isEn = lang.includes('en');
            const isJa = lang.includes('ja') || lang.includes('jp');

            // Find HP bar if present
            let hpBar = playerState.player_status?.status_bars?.find(b => b.type === 'hp' || b.name === 'HP' || b.name === '生命值');
            const maxHp = hpBar?.max || 100;

            if (action === 'eat') {
                if ((resData.food || 0) <= 0) {
                    return sendError(res, 400, isEn ? 'No food rations left!' : isJa ? '食料がありません！' : '沒有可用的食物口糧！');
                }
                resData.food -= 1;
                ws.hunger = Math.min(100, (ws.hunger || 0) + 35);
                ws.stamina = Math.min(ws.max_stamina || 100, (ws.stamina || 0) + 25);
                playerState.stamina = ws.stamina;
                const spBar = playerState.player_status?.status_bars?.find(b => b.type === 'sp' || b.name === '精力' || b.name === '體力');
                if (spBar) spBar.value = ws.stamina;
                if (hpBar) hpBar.value = Math.min(maxHp, (hpBar.value || 0) + 10);
                logMessage = isEn 
                    ? '🍖 Consumed 1 Food Ration (+35 Hunger, +25 Stamina, +10 HP).'
                    : isJa
                    ? '🍖 食料を1個消費しました（空腹度+35、スタミナ+25、HP+10）。'
                    : '🍖 食用了 1 份食物口糧（飽腹度 +35，精力 +25，生命值 +10）。';
            } else if (action === 'drink') {
                if ((resData.water || 0) <= 0) {
                    return sendError(res, 400, isEn ? 'No clean water left!' : isJa ? 'きれいな水がありません！' : '沒有可用的純淨水！');
                }
                resData.water -= 1;
                ws.hydration = Math.min(100, (ws.hydration || 0) + 40);
                ws.stamina = Math.min(ws.max_stamina || 100, (ws.stamina || 0) + 15);
                playerState.stamina = ws.stamina;
                const spBar = playerState.player_status?.status_bars?.find(b => b.type === 'sp' || b.name === '精力' || b.name === '體力');
                if (spBar) spBar.value = ws.stamina;
                logMessage = isEn 
                    ? '💧 Drank 1 Pure Water (+40 Hydration, +15 Stamina).'
                    : isJa
                    ? '💧 純水を1個消費しました（水分+40、スタミナ+15）。'
                    : '💧 飲用了 1 份純淨水（水分 +40，精力 +15）。';
            } else if (action === 'medicine') {
                if ((resData.medicine || 0) <= 0) {
                    return sendError(res, 400, isEn ? 'No medical supplies left!' : isJa ? '医薬品がありません！' : '沒有可用的急救藥品！');
                }
                resData.medicine -= 1;
                if (hpBar) hpBar.value = Math.min(maxHp, (hpBar.value || 0) + 45);
                ws.survival_status = 'NORMAL';
                logMessage = isEn 
                    ? '💊 Used 1 Medical Kit (+45 HP, cleared negative status).'
                    : isJa
                    ? '💊 応急キットを使用しました（HP+45、状態異常解除）。'
                    : '💊 使用了 1 份急救藥品（生命值 +45，清除了負面異常狀態！）。';
            } else {
                return sendError(res, 400, 'Invalid resource action');
            }

            // Re-evaluate survival status
            if (ws.hunger > 20 && ws.hydration > 20 && ws.stamina > 20) {
                ws.survival_status = 'NORMAL';
            } else if (ws.hunger <= 20) {
                ws.survival_status = 'STARVING';
            } else if (ws.hydration <= 20) {
                ws.survival_status = 'DEHYDRATED';
            } else if (ws.stamina <= 0) {
                ws.survival_status = 'EXHAUSTED';
            }

            return sendJson(res, 200, {
                success: true,
                message: logMessage,
                playerState,
                world_state: ws
            });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    if (pathname === '/api/camp/action' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { action, playerState, language } = body;
            if (!playerState) {
                return sendError(res, 400, 'Player state is required');
            }

            ensureFullWorldState(playerState);
            const ws = playerState.world_state;
            const camp = playerState.camp_state;
            const resData = ws.resources;
            const lang = (language || playerState.language || 'zh-TW').toLowerCase();
            const isEn = lang.includes('en');
            const isJa = lang.includes('ja') || lang.includes('jp');

            // 1. Check if player is in restricted state (combat or event locked)
            if (isStateRestricted(playerState)) {
                return sendError(res, 400, isEn 
                    ? '❌ Currently in restricted state (combat or event locked), cannot perform camp action!' 
                    : isJa 
                    ? '❌ 現在は制限された状態（戦闘中またはイベントロック中）のため、キャンプ行動を実行できません！' 
                    : '❌ 当前处于受限状态（战斗中或关键事件锁定），无法执行营地休整行动！');
            }

            let hpBar = playerState.player_status?.status_bars?.find(b => b.type === 'hp' || b.name === 'HP' || b.name === '生命值');
            const maxHp = hpBar?.max || 100;
            let logMessage = '';
            let ambushed = false;

            if (action === 'rest') {
                // Short Rest: costs 5 hunger, 5 hydration -> gains 30% stamina (30 SP), 15 HP
                ws.hunger = Math.max(0, (ws.hunger || 100) - 5);
                ws.hydration = Math.max(0, (ws.hydration || 100) - 5);
                const maxSp = ws.max_stamina || 100;
                const spGain = Math.round(maxSp * 0.3);
                ws.stamina = Math.min(maxSp, (ws.stamina || 0) + spGain);
                playerState.stamina = ws.stamina;
                const spBar = playerState.player_status?.status_bars?.find(b => b.type === 'sp' || b.name === '精力' || b.name === '體力');
                if (spBar) spBar.value = ws.stamina;
                if (hpBar) hpBar.value = Math.min(maxHp, (hpBar.value || 0) + 15);

                // Small chance of gathering 1 wild berry/food if foraging in safe zone
                let bonus = '';
                if (Math.random() < 0.25) {
                    resData.food += 1;
                    bonus = isEn ? ' (Found +1 Wild Ration nearby!)' : isJa ? ' (周辺で野生の食料を1個採取しました！)' : '（在營地周邊順手採集了 1 份野果口糧！）';
                }

                logMessage = isEn
                    ? `⛺ Short Rest completed. Restored +${spGain} Stamina, +15 HP (Cost: -5 Hunger, -5 Hydration).${bonus}`
                    : isJa
                    ? `⛺ 軽い休息をとりました。スタミナ+${spGain}、HP+15回復（消費: 空腹度-5、水分-5）。${bonus}`
                    : `⛺ 在營地稍作休整，恢復了 ${spGain} 點精力（30%）與 15 點生命值（消耗：飽腹度 -5，水分 -5）。${bonus}`;
            } else if (action === 'sleep') {
                // Long Sleep / Camp Overnight: advances day +1, costs 15 hunger & hydration, restores full stamina & 50 HP
                camp.days = (camp.days || 1) + 1;
                ws.time = isEn ? `Day ${camp.days}` : isJa ? `第 ${camp.days} 日` : `第 ${camp.days} 天`;

                ws.hunger = Math.max(0, (ws.hunger || 100) - 15);
                ws.hydration = Math.max(0, (ws.hydration || 100) - 15);
                ws.stamina = ws.max_stamina || 100;
                playerState.stamina = ws.stamina;
                const spBar = playerState.player_status?.status_bars?.find(b => b.type === 'sp' || b.name === '精力' || b.name === '體力');
                if (spBar) spBar.value = ws.stamina;
                if (hpBar) hpBar.value = Math.min(maxHp, (hpBar.value || 0) + 50);

                // Calculate Ambush Risk
                // Base: 35%. Bonfire lit: -15%. Shelter Lv2: -15%. Shelter Lv3: 0% ambush
                let ambushChance = 35;
                if (camp.campfire_lit) ambushChance -= 15;
                if (camp.shelter_level === 2) ambushChance -= 15;
                if (camp.shelter_level >= 3) ambushChance = 0;

                const roll = Math.random() * 100;
                if (roll < ambushChance) {
                    ambushed = true;
                    // Ambushed at night!
                    const hpLoss = 15;
                    if (hpBar) hpBar.value = Math.max(1, (hpBar.value || 100) - hpLoss);
                    if (resData.food > 0) resData.food -= 1;
                    camp.campfire_lit = false;

                    logMessage = isEn
                        ? `⚠️ [NIGHT AMBUSH!] Hostile prowlers raided the camp while sleeping! Lost 1 Food Ration, suffered -${hpLoss} HP damage!`
                        : isJa
                        ? `⚠️ [夜間襲撃！] 睡眠中に敵の襲撃を受けました！食料1個を奪われ、HPが${hpLoss}減少しました！`
                        : `⚠️【深夜夜襲警報！】徘徊的野獸或掠奪者襲擊了未完全防禦的營地！損失了 1 份食物，生命值受到 ${hpLoss} 點偷襲傷害！`;
                } else {
                    // Safe night
                    camp.campfire_lit = false; // Fire goes out by morning
                    logMessage = isEn
                        ? `🌙 Spent a peaceful night at camp. Advanced to Day ${camp.days}! Stamina fully restored to 100%, HP +50.`
                        : isJa
                        ? `🌙 平穏な夜を過ごしました。第${camp.days}日になりました！スタミナが全快し、HP+50回復。`
                        : `🌙 一夜安眠，晨光微熹。時間推進至【第 ${camp.days} 天】！精力完全恢復至 100%，生命值大幅回升。`;
                }
            } else if (action === 'stoke_fire') {
                if ((resData.wood || 0) < 1) {
                    return sendError(res, 400, isEn ? 'Requires 1 Wood to stoke the bonfire!' : isJa ? '焚き火を起こすには木材が1個必要です！' : '生火或添柴需要消耗 1 份木材！');
                }
                resData.wood -= 1;
                camp.campfire_lit = true;
                logMessage = isEn
                    ? '🔥 Stoked the campfire! The warm blaze wards off cold and substantially reduces night ambush risk.'
                    : isJa
                    ? '🔥 焚き火を灯しました！暖かな炎が寒さを防ぎ、夜間襲撃の危険を大幅に低減します。'
                    : '🔥 點燃了營火！溫暖的火光驅散了寒冷與黑暗，夜間遭遇夜襲的危險顯著降低。';
            } else if (action === 'upgrade_shelter') {
                const curLvl = camp.shelter_level || 1;
                if (curLvl >= 3) {
                    return sendError(res, 400, isEn ? 'Shelter is already at maximum rank (Lv3 Outpost)!' : isJa ? '避難所は既に最高レベル（Lv3 前哨基地）です！' : '庇護所已達最高防禦等級（Lv3 堅固前哨基地）！');
                }

                const neededWood = curLvl === 1 ? 4 : 8;
                if ((resData.wood || 0) < neededWood) {
                    return sendError(res, 400, isEn 
                        ? `Not enough wood! Requires ${neededWood} wood to upgrade.` 
                        : isJa 
                        ? `木材が足りません！強化には木材${neededWood}個が必要です。`
                        : `木材不足！升級避難所需要 ${neededWood} 份木材。`);
                }

                resData.wood -= neededWood;
                camp.shelter_level = curLvl + 1;

                if (camp.shelter_level === 2) {
                    logMessage = isEn
                        ? '🛠️ Upgraded Shelter to [Lv2 Fortified Camp]! Ambush risk significantly reduced, unlocked storage.'
                        : isJa
                        ? '🛠️ 避難所を【Lv2 強化キャンプ】にアップグレードしました！襲撃リスクが大幅に低減。'
                        : '🛠️ 營地加固升級為【Lv2 堅固避難所】！夜襲概率大幅下降，解鎖防禦工事加成。';
                } else {
                    logMessage = isEn
                        ? '🏰 Upgraded Shelter to [Lv3 Secure Outpost]! Immune to night ambushes and grants sanctuary ward!'
                        : isJa
                        ? '🏰 避難所を【Lv3 堅固な前哨基地】にアップグレードしました！夜間襲撃を完全無効化！'
                        : '🏰 營地加固升級為【Lv3 堅固前哨基地】！徹底杜絕夜間偷襲，獲得全方位庇護所結界加成！';
                }
            } else if (action === 'chop_wood') {
                if ((ws.stamina || 0) < 8) {
                    return sendError(res, 400, isEn ? 'Not enough stamina (need 8 SP) to chop wood!' : isJa ? 'スタミナ不足（8 SP必要）のため伐採できません！' : '精力不足（需要 8 點精力），無法進行伐木！');
                }
                ws.stamina = Math.max(0, (ws.stamina || 0) - 8);
                playerState.stamina = ws.stamina;
                const spBar = playerState.player_status?.status_bars?.find(b => b.type === 'sp' || b.name === '精力' || b.name === '體力');
                if (spBar) spBar.value = ws.stamina;
                ws.hydration = Math.max(0, (ws.hydration || 0) - 4);

                const woodCount = Math.floor(Math.random() * 3) + 2; // 2 ~ 4 wood
                resData.wood = (resData.wood || 0) + woodCount;

                // Sync to player inventory
                const inv = playerState.player_status.inventory = playerState.player_status.inventory || [];
                const woodName = isEn ? 'Dry Timber Wood' : isJa ? '乾燥木材' : '乾燥木材';
                inv.push({
                    name: woodName,
                    type: 'wood',
                    rarity: 'common',
                    value: 3,
                    quantity: woodCount,
                    description: isEn ? 'Lumber suitable for campfire or shelter fortification.' : '可用於營火燃燒與庇護所加固的乾燥優質木料。'
                });

                let bonusText = '';
                if (Math.random() < 0.45) {
                    const tinderName = isEn ? 'Dry Tinder & Twigs' : isJa ? '乾樹枝與火絨' : '乾樹枝與火絨';
                    inv.push({
                        name: tinderName,
                        type: 'material',
                        rarity: 'common',
                        value: 2,
                        description: isEn ? 'Dry twigs useful for quick fire starting.' : '便於引火點燃營火的乾燥細枝與火絨。'
                    });
                    bonusText = isEn ? ' + Bonus Tinder & Twigs' : isJa ? ' + 乾樹枝與火絨' : '，並額外收集了【乾樹枝與火絨】';
                }

                logMessage = isEn
                    ? `🪓 Chopped timber around camp (-8 SP). Obtained: +${woodCount} Wood${bonusText}!`
                    : isJa
                    ? `🪓 キャンプ周辺で木を伐採しました（-8 SP）。獲得: 木材+${woodCount}${bonusText}！`
                    : `🪓 揮斧砍伐營地周遭枯木柴火（消耗 8 精力），成功採集了 ${woodCount} 份【乾燥木材】${bonusText}！`;
            } else if (action === 'forage_food_water') {
                if ((ws.stamina || 0) < 6) {
                    return sendError(res, 400, isEn ? 'Not enough stamina (need 6 SP) to forage!' : isJa ? 'スタミナ不足（6 SP必要）のため採集できません！' : '精力不足（需要 6 點精力），無法進行覓食與打水！');
                }
                ws.stamina = Math.max(0, (ws.stamina || 0) - 6);
                playerState.stamina = ws.stamina;
                const spBar = playerState.player_status?.status_bars?.find(b => b.type === 'sp' || b.name === '精力' || b.name === '體力');
                if (spBar) spBar.value = ws.stamina;

                const foodGained = Math.floor(Math.random() * 2) + 1; // 1 ~ 2
                const waterGained = Math.random() < 0.75 ? (Math.floor(Math.random() * 2) + 1) : 0; // 0 ~ 2

                resData.food = (resData.food || 0) + foodGained;
                if (waterGained > 0) resData.water = (resData.water || 0) + waterGained;

                const inv = playerState.player_status.inventory = playerState.player_status.inventory || [];
                const foodName = isEn ? 'Wild Rations & Berries' : isJa ? '採集の野果と食料' : '採集的野果與口糧';
                inv.push({
                    name: foodName,
                    type: 'food',
                    rarity: 'common',
                    value: 2,
                    quantity: foodGained,
                    effect_target: 'hunger',
                    effect_percent: 0.25,
                    description: isEn ? 'Wild edible berries and game found nearby.' : '在營地周遭採集到的天然野果與可食用口糧。'
                });

                if (waterGained > 0) {
                    const waterName = isEn ? 'Fresh Mountain Water' : isJa ? '汲取の山泉水' : '汲取的清甜山泉水';
                    inv.push({
                        name: waterName,
                        type: 'water',
                        rarity: 'common',
                        value: 2,
                        quantity: waterGained,
                        effect_target: 'thirst',
                        effect_percent: 0.30,
                        description: isEn ? 'Fresh purified water scooped from a nearby brook.' : '自附近純淨溪流取回的飲用水源。'
                    });
                }

                const parts = [`+${foodGained} ${isEn ? 'Food' : '食物口糧'}`];
                if (waterGained > 0) parts.push(`+${waterGained} ${isEn ? 'Pure Water' : '清甜水源'}`);

                logMessage = isEn
                    ? `🌿 Foraged nearby vegetation and spring (-6 SP). Gathered: ${parts.join(', ')}!`
                    : isJa
                    ? `🌿 周辺で食料と水を採取しました（-6 SP）。獲得: ${parts.join('、')}！`
                    : `🌿 在營地周圍尋獲野果與水源（消耗 6 精力），採集獲得：${parts.join('、')}！`;
            } else if (action === 'sell_junk' || action === 'sell_item') {
                const { itemName, price } = body;
                if (!itemName) {
                    return sendError(res, 400, 'Item name is required to sell');
                }
                const inv = playerState.player_status.inventory = playerState.player_status.inventory || [];
                const itemIdx = inv.findIndex(i => (typeof i === 'object' ? i.name : i) === itemName);
                if (itemIdx === -1) {
                    return sendError(res, 400, isEn ? 'Item not found in inventory!' : isJa ? 'アイテムが所持品に見つかりません！' : '背包中未找到該物品！');
                }
                const removedItem = inv.splice(itemIdx, 1)[0];
                const sellValue = (typeof price === 'number' && price > 0) ? price : (typeof removedItem === 'object' ? (removedItem.value || 5) : 5);
                
                playerState.player_status.currency = (playerState.player_status.currency || 0) + sellValue;
                playerState.gold = playerState.player_status.currency;
                const cName = playerState.player_status.currency_name || '金幣';

                logMessage = isEn
                    ? `💰 Sold [${itemName}] for +${sellValue} ${cName}.`
                    : isJa
                    ? `💰 [${itemName}] を売却し、+${sellValue} ${cName} を獲得しました。`
                    : `💰 成功出售【${itemName}】，獲得了 +${sellValue} ${cName}！`;
            } else if (action === 'forage') {
                if ((ws.stamina || 0) < 8) {
                    return sendError(res, 400, isEn ? 'Not enough stamina (need 8 SP) to scavenge!' : isJa ? 'スタミナ不足（8 SP必要）のため採取できません！' : '精力不足（需要 8 點精力），無法進行搜救或採集！');
                }
                ws.stamina = Math.max(0, (ws.stamina || 0) - 8);
                playerState.stamina = ws.stamina;
                const spBar = playerState.player_status?.status_bars?.find(b => b.type === 'sp' || b.name === '精力' || b.name === '體力');
                if (spBar) spBar.value = ws.stamina;
                ws.hydration = Math.max(0, (ws.hydration || 0) - 5);

                const lootTypes = ['wood', 'food', 'water', 'medicine'];
                const weights = [0.4, 0.3, 0.25, 0.05];
                const count = Math.random() < 0.6 ? 1 : 2;
                const found = [];
                const inv = playerState.player_status.inventory = playerState.player_status.inventory || [];

                for (let i = 0; i < count; i++) {
                    const r = Math.random();
                    let cumulative = 0;
                    for (let j = 0; j < lootTypes.length; j++) {
                        cumulative += weights[j];
                        if (r <= cumulative) {
                            const item = lootTypes[j];
                            resData[item] = (resData[item] || 0) + 1;
                            const itemZh = item === 'wood' ? '木材' : item === 'food' ? '食物口糧' : item === 'water' ? '純淨水' : '急救草藥';
                            const itemEn = item === 'wood' ? 'Wood' : item === 'food' ? 'Food Ration' : item === 'water' ? 'Pure Water' : 'Herbal Medicine';
                            const itemJa = item === 'wood' ? '木材' : item === 'food' ? '食料' : item === 'water' ? '純水' : '薬草';
                            const dispName = isEn ? itemEn : isJa ? itemJa : itemZh;
                            found.push(dispName);
                            inv.push({
                                name: dispName,
                                type: item,
                                rarity: 'common',
                                value: item === 'medicine' ? 8 : 3,
                                effect_percent: item === 'food' ? 0.25 : item === 'water' ? 0.3 : 0.2
                            });
                            break;
                        }
                    }
                }

                logMessage = isEn
                    ? `🏕️ Scavenged the camp perimeter (-8 SP). Found: ${found.join(', ')}!`
                    : isJa
                    ? `🏕️ キャンプ周辺を探索しました（-8 SP）。獲得: ${found.join('、')}！`
                    : `🏕️ 在營地周圍巡邏與搜集（消耗 8 精力），尋獲了：${found.join('、')}！`;
            } else {
                return sendError(res, 400, 'Unknown camp action');
            }

            // Update status string
            if (ws.hunger > 20 && ws.hydration > 20 && ws.stamina > 20) {
                ws.survival_status = 'NORMAL';
            } else if (ws.hunger <= 20) {
                ws.survival_status = 'STARVING';
            } else if (ws.hydration <= 20) {
                ws.survival_status = 'DEHYDRATED';
            } else if (ws.stamina <= 0) {
                ws.survival_status = 'EXHAUSTED';
            }

            return sendJson(res, 200, {
                success: true,
                message: logMessage,
                ambushed,
                playerState,
                world_state: ws,
                camp_state: camp
            });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    // ==========================================
    // 3.5 探索与搜刮系统路由 (Exploration & Scavenging & Maze)
    // ==========================================
    // 1. 生成或刷新当前区域的可搜索点 (Generate Searchable POIs)
    if (pathname === '/api/explore/pois' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { playerState, language } = body;
            const lang = language || playerState?.language || 'zh-TW';
            const isEn = lang.toLowerCase().includes('en');
            const isJa = lang.toLowerCase().includes('ja') || lang.toLowerCase().includes('jp');

            if (playerState) {
                ensureFullWorldState(playerState);
                if (isStateRestricted(playerState)) {
                    return sendError(res, 400, isEn 
                        ? '❌ Currently in restricted state (combat or event locked), cannot search area!' 
                        : isJa 
                        ? '❌ 現在は制限された状態のため、周辺探索を行えません！' 
                        : '❌ 当前处于受限状态（战斗中或事件锁定），无法进行探索搜刮！');
                }
            }

            const worldType = playerState?.world_theme || playerState?.genre || 'post_apoc';
            const zoneType = playerState?.explore_state?.zone_type || 'safe';

            // POI templates based on genre and zone
            const poiTemplates = {
                chest: [
                    { id: 'chest_1', name_zh: '生鏽的金屬儲物箱', name_en: 'Rusted Metal Chest', name_ja: '錆びた金属の保管箱', type: 'chest', minigame: 'scratch', desc_zh: '鎖頭有些鬆動的堅固金屬箱，裡面可能保存著完好的補給物資。', desc_en: 'A solid metal box with a loose latch, likely containing rations or supplies.', desc_ja: '留め具が緩んだ頑丈な金属箱。保存食などの物資が入っていそうだ。', danger_rating: 15 },
                    { id: 'chest_2', name_zh: '鎖死的軍用物資箱', name_en: 'Locked Military Crate', name_ja: '施錠された軍用物資箱', type: 'chest', minigame: 'popup', desc_zh: '密封嚴密的軍用物資箱，隱約有機械防盜機關的咔嗒聲。', desc_en: 'A tightly sealed military container with mechanical traps.', desc_ja: '厳重に密封された軍用箱。罠が仕掛けられている気配がする。', danger_rating: 25 }
                ],
                corpse: [
                    { id: 'corpse_1', name_zh: '倒斃的前探索者遺骸', name_en: 'Fallen Explorer Remains', name_ja: '倒れた探索者の遺骸', type: 'corpse', minigame: 'scratch', desc_zh: '倒在角落的旅行者，身上還掛著隨身行囊與武器配件。', desc_en: 'A traveler slumped in the corner, carrying gear and weapon accessories.', desc_ja: '物陰に倒れた旅人。まだ装備や武器パーツを身につけている。', danger_rating: 20 },
                    { id: 'corpse_2', name_zh: '變異掠食者的殘骸', name_en: 'Mutated Beast Carcass', name_ja: '変異捕食者の死骸', type: 'corpse', minigame: 'scratch', desc_zh: '剛死不久的兇猛生物，或許能取下堅硬的甲殼或利齒。', desc_en: 'A recently slain beast from which durable fangs or carapaces can be harvested.', desc_ja: '息絶えたばかりの凶暴な獣。硬い甲殻や牙が採取できそうだ。', danger_rating: 30 }
                ],
                ruins: [
                    { id: 'ruins_1', name_zh: '半掩埋的建築瓦礫堆', name_en: 'Buried Rubble Mound', name_ja: '半埋没の瓦礫の山', type: 'ruins', minigame: 'dig', desc_zh: '散落著磚石與金屬構件的殘骸，翻開深處可能找到實用建材。', desc_en: 'Piled masonry and metal scraps. Digging deep may uncover valuable components.', desc_ja: '石と金属片が散らばる瓦礫。掘り起こせば建築素材が見つかるかもしれない。', danger_rating: 15 },
                    { id: 'ruins_2', name_zh: '坍塌的實驗室廢墟', name_en: 'Collapsed Laboratory Ruins', name_ja: '崩壊した研究所の残骸', type: 'ruins', minigame: 'dig', desc_zh: '碎裂的儀器與容器堆積在此，可能挖出化學試劑或稀有材料。', desc_en: 'Shattered instruments and glass flasks that might yield rare compounds.', desc_ja: '粉々になった機材が散乱している。貴重な試薬や素材が見つかるかもしれない。', danger_rating: 30 }
                ],
                shelf: [
                    { id: 'shelf_1', name_zh: '積灰的物資貨架', name_en: 'Dusty Supply Shelf', name_ja: '埃をかぶった物資棚', type: 'shelf', minigame: 'scratch', desc_zh: '上面雜亂地擺放著各種罐頭與廢舊雜物。', desc_en: 'Cans and miscellaneous junk scattered on old shelves.', desc_ja: '缶詰や日用雑品が無造作に並んでいる。', danger_rating: 10 }
                ]
            };

            // Select 2-3 POIs randomly
            const pois = [];
            const types = ['chest', 'corpse', 'ruins', 'shelf'];
            const count = Math.min(4, Math.floor(Math.random() * 2) + 2);
            for (let i = 0; i < count; i++) {
                const t = types[i % types.length];
                const pool = poiTemplates[t];
                const selected = JSON.parse(JSON.stringify(pool[Math.floor(Math.random() * pool.length)]));
                selected.id = `${selected.id}_${Date.now()}_${i}`;
                selected.displayName = isEn ? selected.name_en : isJa ? selected.name_ja : selected.name_zh;
                selected.displayDesc = isEn ? selected.desc_en : isJa ? selected.desc_ja : selected.desc_zh;
                pois.push(selected);
            }

            return sendJson(res, 200, {
                success: true,
                pois,
                zoneType,
                message: isEn ? 'Found potential scavenge points in the area.' : isJa ? '周囲に探索可能なポイントを発見しました。' : '在當前區域偵測到了可供搜刮的目標點。'
            });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    // 2. 搜刮小遊戲結算與戰利品生成 (Settle Scavenge Loot)
    if (pathname === '/api/explore/scavenge' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { poi, scratchPercent, depthScratched, playerState, language, currentRisk } = body;
            const lang = language || playerState?.language || 'zh-TW';
            const isEn = lang.toLowerCase().includes('en');
            const isJa = lang.toLowerCase().includes('ja') || lang.toLowerCase().includes('jp');

            if (playerState) {
                ensureFullWorldState(playerState);
                if (isStateRestricted(playerState)) {
                    return sendError(res, 400, isEn 
                        ? '❌ Currently in restricted state, cannot scavenge!' 
                        : isJa 
                        ? '❌ 現在は制限された状態のため、搜刮を行えません！' 
                        : '❌ 当前处于受限状态（战斗中或事件锁定），无法进行搜刮！');
                }
            }

            const ws = playerState.world_state;
            const spCost = Math.min(10, Math.max(8, Math.floor((scratchPercent || 50) / 10)));
            ws.stamina = Math.max(0, (ws.stamina || 100) - spCost);
            playerState.stamina = ws.stamina;
            const spBar = playerState.player_status?.status_bars?.find(b => b.type === 'sp' || b.name === '精力' || b.name === '體力');
            if (spBar) spBar.value = ws.stamina;
            if (ws.stamina <= 0) {
                ws.survival_status = 'EXHAUSTED';
            }

            // Calculate loot yield based on POI type and reveal depth
            const percent = Math.min(100, Math.max(0, scratchPercent || 50));
            let riskIncrement = Math.floor(percent * 0.35) + Math.floor(Math.random() * 10);
            let trapTriggered = false;
            let trapDamage = 0;

            const lootTable = {
                chest: [
                    { name_zh: '密封肉類罐頭', name_en: 'Sealed Meat Can', name_ja: '密封肉の缶詰', type: 'food', val: 1, rarity: 'common', depth: 20 },
                    { name_zh: '淨化水壺', name_en: 'Purified Water Flask', name_ja: '浄水フラスコ', type: 'water', val: 1, rarity: 'common', depth: 30 },
                    { name_zh: '沉甸甸的錢袋', name_en: 'Heavy Coin Pouch', name_ja: 'ずっしりとした金貨袋', type: 'money_container', val: 25, rarity: 'uncommon', depth: 40 },
                    { name_zh: '急救繃帶包', name_en: 'First Aid Bandages', name_ja: '応急包帯セット', type: 'medicine', val: 1, rarity: 'uncommon', depth: 55 },
                    { name_zh: '舊時代軍用口糧', name_en: 'Military MRE Pack', name_ja: '軍用MREレーション', type: 'food', val: 2, rarity: 'rare', depth: 80 }
                ],
                corpse: [
                    { name_zh: '磨損的短匕首', name_en: 'Worn Dagger', name_ja: '使い古された短剣', type: 'weapon', val: 1, rarity: 'common', depth: 20 },
                    { name_zh: '死者錢包與碎銀', name_en: 'Purse & Silver Pieces', name_ja: '財布と銀貨', type: 'money_container', val: 15, rarity: 'common', depth: 35 },
                    { name_zh: '強化皮革護手', name_en: 'Reinforced Leather Bracers', name_ja: '強化革の篭手', type: 'armor', val: 1, rarity: 'uncommon', depth: 50 },
                    { name_zh: '生鏽的求生砍刀', name_en: 'Rusted Machete', name_ja: '錆びたサバイバルナタ', type: 'weapon', val: 1, rarity: 'rare', depth: 75 },
                    { name_zh: '舊式戰術背心', name_en: 'Vintage Tactical Vest', name_ja: '旧式タクティカルベスト', type: 'armor', val: 1, rarity: 'rare', depth: 90 }
                ],
                ruins: [
                    { name_zh: '乾硬木材', name_en: 'Hardened Wood Planks', name_ja: '硬質木材', type: 'wood', val: 2, rarity: 'common', depth: 15 },
                    { name_zh: '金屬廢料與螺栓', name_en: 'Scrap Metal & Bolts', name_ja: '金属スクラップとボルト', type: 'material', val: 3, rarity: 'common', depth: 35 },
                    { name_zh: '古代金幣陶罐', name_en: 'Ancient Coin Urn', name_ja: '古代金貨の壺', type: 'money_container', val: 30, rarity: 'rare', depth: 60 },
                    { name_zh: '完整電路元件', name_en: 'Intact Circuit Component', name_ja: '無傷の電子回路', type: 'material', val: 1, rarity: 'rare', depth: 70 },
                    { name_zh: '高強度合金板', name_en: 'High-Tensile Alloy Sheet', name_ja: '高張力合金プレート', type: 'material', val: 1, rarity: 'rare', depth: 85 }
                ],
                shelf: [
                    { name_zh: '瓶裝飲用水', name_en: 'Bottled Water', name_ja: 'ボトル入り飲料水', type: 'water', val: 1, rarity: 'common', depth: 20 },
                    { name_zh: '隱藏的零錢盒', name_en: 'Stashed Coin Box', name_ja: '隠された小銭入れ', type: 'money_container', val: 12, rarity: 'common', depth: 25 },
                    { name_zh: '壓縮餅乾', name_en: 'Compressed Biscuit', name_ja: '圧縮乾パン', type: 'food', val: 1, rarity: 'common', depth: 35 },
                    { name_zh: '火柴與引火物', name_en: 'Matches & Tinder', name_ja: 'マッチと着火剤', type: 'wood', val: 1, rarity: 'common', depth: 50 }
                ]
            };

            const poiType = poi?.type || 'chest';
            const pool = lootTable[poiType] || lootTable.chest;
            const discoveredLoot = [];

            pool.forEach(item => {
                if (percent >= item.depth) {
                    const itemName = isEn ? item.name_en : isJa ? item.name_ja : item.name_zh;
                    discoveredLoot.push({
                        id: `loot_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
                        name: itemName,
                        type: item.type,
                        val: item.val,
                        rarity: item.rarity,
                        source: poi?.displayName || 'Scavenge'
                    });
                }
            });

            // Trap check for deep scratching on dangerous POIs
            if (percent > 70 && Math.random() < 0.25) {
                trapTriggered = true;
                trapDamage = Math.floor(Math.random() * 12) + 5;
                if (playerState.player_status?.status_bars) {
                    const hpBar = playerState.player_status.status_bars.find(b => b.type === 'hp');
                    if (hpBar) hpBar.value = Math.max(1, hpBar.value - trapDamage);
                }
            }

            // Calculate resulting risk
            const newRisk = Math.min(100, (currentRisk || 0) + riskIncrement);
            const breach = newRisk >= 100;

            let logMsg = '';
            if (trapTriggered) {
                logMsg = isEn 
                    ? `⚠️ Trap triggered during deep search! Took ${trapDamage} damage, uncovered ${discoveredLoot.length} items.`
                    : isJa 
                    ? `⚠️ 探索中に罠が作動！${trapDamage}ダメージを受けました。${discoveredLoot.length}個の物品を発見。`
                    : `⚠️ 深層搜刮時觸發了機關陷阱！受到 ${trapDamage} 點傷害，發現了 ${discoveredLoot.length} 件戰利品。`;
            } else {
                logMsg = isEn 
                    ? `🔍 Scavenged thoroughly (${percent}% revealed). Found ${discoveredLoot.length} items!`
                    : isJa 
                    ? `🔍 探索完了（露出度${percent}%）。${discoveredLoot.length}個の物品を獲得！`
                    : `🔍 搜刮完成（探索深度 ${percent}%），尋獲了 ${discoveredLoot.length} 件戰利品！`;
            }

            return sendJson(res, 200, {
                success: true,
                loot: discoveredLoot,
                spCost,
                trapTriggered,
                trapDamage,
                riskIncrement,
                newRisk,
                breach,
                message: logMsg,
                playerState,
                world_state: ws
            });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    // 3. 安全撤離與戰利品正式結算 (Extract & Secure Loot)
    if (pathname === '/api/explore/extract' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { scavengedLoot, playerState, language, forcedEscape } = body;
            const lang = language || playerState?.language || 'zh-TW';
            const isEn = lang.toLowerCase().includes('en');
            const isJa = lang.toLowerCase().includes('ja') || lang.toLowerCase().includes('jp');

            if (playerState) {
                ensureFullWorldState(playerState);
            }

            const ws = playerState.world_state;
            const inv = playerState.player_status.inventory = playerState.player_status.inventory || [];
            const secured = [];
            const lost = [];

            if (forcedEscape) {
                // When forced to escape due to ambush or breach, 50% chance to drop heavy loot
                (scavengedLoot || []).forEach(item => {
                    if (Math.random() < 0.5) {
                        secured.push(item);
                    } else {
                        lost.push(item);
                    }
                });
            } else {
                secured.push(...(scavengedLoot || []));
            }

            // Transfer secured items into inventory and world_state resources
            let gainedCurrency = 0;
            secured.forEach(item => {
                if (item.type === 'wood') {
                    ws.resources.wood = (ws.resources.wood || 0) + (item.val || 1);
                } else if (item.type === 'food') {
                    ws.resources.food = (ws.resources.food || 0) + (item.val || 1);
                } else if (item.type === 'water') {
                    ws.resources.water = (ws.resources.water || 0) + (item.val || 1);
                } else if (item.type === 'medicine') {
                    ws.resources.medicine = (ws.resources.medicine || 0) + (item.val || 1);
                } else if (item.type === 'money_container' || item.type === 'gold' || item.type === 'currency') {
                    const goldAmount = item.val || item.value || 15;
                    gainedCurrency += goldAmount;
                    playerState.player_status.currency = (playerState.player_status.currency || 0) + goldAmount;
                    playerState.gold = playerState.player_status.currency;
                }

                inv.push({
                    name: item.name,
                    type: item.type,
                    rarity: item.rarity || 'common',
                    value: item.val || item.value || 1,
                    effect_percent: item.type === 'food' ? 0.25 : item.type === 'water' ? 0.3 : 0.2
                });
            });

            const summaryNames = secured.map(i => i.name).slice(0, 4).join(', ');
            let currencyBonusText = '';
            if (gainedCurrency > 0) {
                const cName = playerState.player_status.currency_name || '金幣';
                currencyBonusText = isEn ? ` (+${gainedCurrency} ${cName} claimed)` : `（獲得 +${gainedCurrency} ${cName}）`;
            }

            let msg = '';
            if (forcedEscape && lost.length > 0) {
                msg = isEn 
                    ? `🏃 Evacuated hastily! Brought out: ${summaryNames || 'None'}, lost ${lost.length} items during retreat.${currencyBonusText}`
                    : isJa 
                    ? `🏃 慌てて撤退しました！持ち出し成功: ${summaryNames || 'なし'}、撤退中に${lost.length}個の物品を紛失。${currencyBonusText}`
                    : `🏃 倉皇撤離！成功帶出：${summaryNames || '無'}，撤退時遺失了 ${lost.length} 件物品。${currencyBonusText}`;
            } else {
                msg = isEn 
                    ? `🎉 Extracted safely with all ${secured.length} items added to your backpack!${currencyBonusText}`
                    : isJa 
                    ? `🎉 安全に撤退完了！獲得した${secured.length}個の物品をインベントリに収納しました。${currencyBonusText}`
                    : `🎉 安全撤離成功！所有 ${secured.length} 件搜刮戰利品已穩妥收入冒險背包！${currencyBonusText}`;
            }

            return sendJson(res, 200, {
                success: true,
                securedCount: secured.length,
                lostCount: lost.length,
                secured,
                lost,
                message: msg,
                playerState,
                world_state: ws
            });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    // 4. 迷宮移動與房間判定 (Maze Step & Node Resolution)
    if (pathname === '/api/explore/maze/step' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { direction, mazeState, playerState, language } = body;
            const lang = language || playerState?.language || 'zh-TW';
            const isEn = lang.toLowerCase().includes('en');
            const isJa = lang.toLowerCase().includes('ja') || lang.toLowerCase().includes('jp');

            if (playerState) {
                ensureFullWorldState(playerState);
                if (isStateRestricted(playerState)) {
                    return sendError(res, 400, isEn 
                        ? '❌ Currently in restricted state, cannot move in maze!' 
                        : isJa 
                        ? '❌ 現在は制限された状態のため、迷宮移動を行えません！' 
                        : '❌ 当前处于受限状态（战斗中或事件锁定），无法在迷宫中移动！');
                }
            }

            const ws = playerState.world_state;
            const spCost = 5;
            ws.stamina = Math.max(0, (ws.stamina || 100) - spCost);
            playerState.stamina = ws.stamina;
            const spBar = playerState.player_status?.status_bars?.find(b => b.type === 'sp' || b.name === '精力' || b.name === '體力');
            if (spBar) spBar.value = ws.stamina;
            if (ws.stamina <= 0) {
                ws.survival_status = 'EXHAUSTED';
            }

            const maze = mazeState || {
                gridSize: 5,
                currentPos: { x: 2, y: 0 },
                exitPos: { x: 2, y: 4 },
                visited: ['2,0'],
                marked: [],
                steps: 0
            };

            const dirMap = {
                forward: { dx: 0, dy: 1 },
                backward: { dx: 0, dy: -1 },
                left: { dx: -1, dy: 0 },
                right: { dx: 1, dy: 0 }
            };

            let eventType = 'corridor'; // corridor, treasure, trap, deadend, exit, monster
            let eventMessage = '';
            let encounterCombat = false;
            let trapDamage = 0;
            let treasureFound = null;

            if (direction === 'mark') {
                const key = `${maze.currentPos.x},${maze.currentPos.y}`;
                if (!maze.marked.includes(key)) {
                    maze.marked.push(key);
                }
                eventMessage = isEn 
                    ? `📍 Left a glowing survival mark on the wall (${key}).`
                    : isJa 
                    ? `📍 壁に発光マーカーを刻み付けました（${key}）。`
                    : `📍 在石壁上刻下了醒目的螢光求生路標（座標 ${key}）。`;
                return sendJson(res, 200, {
                    success: true,
                    mazeState: maze,
                    eventType: 'mark',
                    message: eventMessage,
                    playerState,
                    world_state: ws
                });
            }

            const delta = dirMap[direction] || { dx: 0, dy: 1 };
            const nextX = Math.max(0, Math.min(maze.gridSize - 1, maze.currentPos.x + delta.dx));
            const nextY = Math.max(0, Math.min(maze.gridSize - 1, maze.currentPos.y + delta.dy));

            // Check if hitting outer boundary
            if (nextX === maze.currentPos.x && nextY === maze.currentPos.y) {
                eventType = 'deadend';
                eventMessage = isEn 
                    ? '🚫 A thick collapsed wall blocks your path. You cannot proceed in this direction.'
                    : isJa 
                    ? '🚫 崩れた瓦礫の壁が行く手を阻んでいます。これ以上進めません。'
                    : '🚫 前方被厚重坍塌的石壁堵死，無法朝此方向繼續前進！';
            } else {
                maze.currentPos = { x: nextX, y: nextY };
                maze.steps = (maze.steps || 0) + 1;
                const posKey = `${nextX},${nextY}`;
                if (!maze.visited.includes(posKey)) {
                    maze.visited.push(posKey);
                }

                // Check Exit
                if (nextX === maze.exitPos.x && nextY === maze.exitPos.y) {
                    eventType = 'exit';
                    eventMessage = isEn 
                        ? '🌟 Found the exit! Daylight and fresh breeze pour into the corridor. Maze cleared!'
                        : isJa 
                        ? '🌟 出口を発見！外光と涼風が差し込み、迷宮を突破しました！'
                        : '🌟 發現了迷宮出口！微風與晨光穿透石隙，你成功突破了錯綜複雜的迷宮！';
                } else {
                    // Random node generator based on coordinates seed
                    const seed = (nextX * 7 + nextY * 13 + maze.steps) % 100;
                    if (seed < 25) {
                        eventType = 'corridor';
                        eventMessage = isEn 
                            ? '👣 Navigated through a quiet winding stone corridor (-5 SP).'
                            : isJa 
                            ? '👣 静まり返った石造りの通路を進みました（-5 SP）。'
                            : '👣 穿越了一段寂靜幽暗的石磚迴廊（消耗 5 精力）。';
                    } else if (seed < 50) {
                        eventType = 'treasure';
                        treasureFound = {
                            name: isEn ? 'Dungeon Relic Chest' : isJa ? '迷宮の宝箱' : '迷宮密室寶箱',
                            type: 'chest'
                        };
                        eventMessage = isEn 
                            ? '💎 Uncovered a hidden alcove containing an ancient chest!'
                            : isJa 
                            ? '💎 隠された小部屋で古代の宝箱を発見しました！'
                            : '💎 發現了一處隱蔽的暗室，裡面矗立著一只古舊的密室寶箱！';
                    } else if (seed < 75) {
                        eventType = 'trap';
                        trapDamage = Math.floor(Math.random() * 10) + 5;
                        if (playerState.player_status?.status_bars) {
                            const hpBar = playerState.player_status.status_bars.find(b => b.type === 'hp');
                            if (hpBar) hpBar.value = Math.max(1, hpBar.value - trapDamage);
                        }
                        eventMessage = isEn 
                            ? `⚠️ Stepped on a concealed pressure plate! Darts dealt ${trapDamage} damage!`
                            : isJa 
                            ? `⚠️ 隠された感圧板を踏んでしまいました！毒矢により${trapDamage}ダメージ！`
                            : `⚠️ 踩中了隱藏的壓力機關！飛矢與落石造成了 ${trapDamage} 點傷害！`;
                    } else {
                        eventType = 'monster';
                        encounterCombat = true;
                        eventMessage = isEn 
                            ? '⚔️ A prowling dungeon beast ambushes you around the corner!'
                            : isJa 
                            ? '⚔️ 通路の角から迷宮の魔獣が奇襲を仕掛けてきました！'
                            : '⚔️ 拐角處猛然躍出一隻潛伏的迷宮凶獸，戰鬥一觸即發！';
                    }
                }
            }

            return sendJson(res, 200, {
                success: true,
                eventType,
                mazeState: maze,
                encounterCombat,
                trapDamage,
                treasureFound,
                message: eventMessage,
                playerState,
                world_state: ws
            });
        } catch (e) {
            return sendError(res, 500, e.message);
        }
    }

    // ==========================================
    // 4. 智能 AI 网关代理路由 (AI Gateway)
    // ==========================================
    if (pathname === '/api/ai/chat' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            let { prompt, model, apiKey, isJson, safetySettings, selectedChoice, playerState, playerAction } = body;

            const activeKey = (apiKey || dbCache.settings.global_api_key || process.env.GEMINI_API_KEY || '').trim();
            if (!activeKey) {
                return sendError(res, 400, '未配置 API Key，请在前端设置中填写金钥或由管理员配置全局 Key');
            }

            const activeModel = model || dbCache.settings.default_model || 'gemini-2.5-flash';

            // --- 選擇後果與隨機判定系統核心 (Backend Outcome Interception System) ---
            let sysMessage = "";
            let outcomeCalculated = null;

            if (playerState) {
                // 確保舊存檔能自動修補缺失欄位且不會崩潰 (Backward Compatibility check)
                ensureFullWorldState(playerState);

                // A. 處理主線推進指令與限制 (Campaign advance & Danger check)
                if (playerAction && playerAction.type === 'campaign') {
                    const isCombat = !!(
                        playerState.combat_state || 
                        playerState.world_state?.flags?.in_combat || 
                        playerState.world_state?.flags?.combat_active ||
                        playerState.world_state?.flags?.combat === 'active'
                    );

                    if (isCombat) {
                        const lang = playerState.language || body.language || 'zh-TW';
                        let errMsg = "❌ 戰鬥中或處於危險時，無法推進主線！請先脫離危險。";
                        if (lang.toLowerCase().includes('en')) {
                            errMsg = "❌ Cannot advance campaign while in danger or combat! Please escape first.";
                        } else if (lang.toLowerCase().includes('ja') || lang.toLowerCase().includes('jp')) {
                            errMsg = "❌ 戦闘中や危険な状態では、メインストーリーを進めることができません。まず危険から脱出してください。";
                        }

                        const structuredResponse = {
                            narrative: errMsg,
                            turn_summary: "Campaign advancement rejected",
                            error_message: errMsg,
                            status_updates: [],
                            world_state: playerState.world_state
                        };

                        return sendJson(res, 200, {
                            success: true,
                            content: JSON.stringify(structuredResponse),
                            error_message: errMsg,
                            unintelligible: false,
                            can_advance_campaign: false,
                            world_state: playerState.world_state,
                            playerState
                        });
                    }

                    // 如果安全，自動切換至过渡模式
                    playerState.world_state.mode = "过渡";
                }

                // B. 主動判定與選擇後果系統 (Authoritative Consequence Determination)
                let isChecking = false;
                let checkType = 'normal'; // 'aggressive', 'cautious', 'smart', 'social'
                let attrName = 'strength';
                let DC = 10;
                let requiredItem = null;
                let requiredNPC = null;
                let requiredNPCVal = 0;
                let checkText = '';
                let checkAction = '';

                if (playerAction) {
                    isChecking = true;
                    // Map active playerAction types to action categories
                    const typeMap = {
                        'move': { type: 'smart', attr: 'dexterity' },
                        'explore': { type: 'smart', attr: 'dexterity' },
                        'interact': { type: 'social', attr: 'charisma' },
                        'survive': { type: 'cautious', attr: 'vitality' },
                        'campaign': { type: 'aggressive', attr: 'strength' }
                    };
                    const mapped = typeMap[playerAction.type] || { type: 'smart', attr: 'dexterity' };
                    checkType = mapped.type;
                    attrName = mapped.attr;
                    checkText = `Active Action: ${playerAction.type} (Target: ${playerAction.target || 'None'})`;
                    checkAction = `PlayerAction:${playerAction.type}`;

                    const chapter = playerState.camp_state?.chapter || 1;
                    DC = 8 + (chapter * 2);

                    // Deduct stamina for active actions: move (-5), explore (-8), other (-5)
                    let deductSp = 5;
                    if (playerAction.type === 'move') deductSp = 5;
                    else if (playerAction.type === 'explore') deductSp = 8;
                    else if (playerAction.type === 'combat') deductSp = 5;
                    else deductSp = 5;

                    playerState.world_state.stamina = Math.max(0, (playerState.world_state.stamina || 100) - deductSp);
                    playerState.stamina = playerState.world_state.stamina;
                    const spBar = playerState.player_status?.status_bars?.find(b => b.type === 'sp' || b.name === '精力' || b.name === '體力');
                    if (spBar) spBar.value = playerState.stamina;
                    if (playerState.world_state.stamina <= 0) {
                        playerState.world_state.survival_status = 'EXHAUSTED';
                    }
                } else if (selectedChoice) {
                    isChecking = true;
                    checkAction = selectedChoice.action || 'SelectedChoice';
                    checkText = selectedChoice.text || 'Selected Option';

                    if (selectedChoice.check) {
                        const check = selectedChoice.check;
                        attrName = check.attribute || 'strength';
                        DC = parseInt(check.difficulty || '10', 10);
                        requiredItem = check.required_item;
                        requiredNPC = check.required_favor_npc;
                        requiredNPCVal = parseInt(check.required_favor_value || '0', 10);
                        checkType = selectedChoice.type || 'normal';
                    } else {
                        // Dynamic Check generation for options without explicit check
                        let sum = 0;
                        const t = checkText;
                        for (let i = 0; i < t.length; i++) sum += t.charCodeAt(i);
                        
                        const textLower = t.toLowerCase();
                        if (/[打殺衝闖強攻奪擊戰攻破]/.test(t) || /attack|fight|rush|charge|strike|break|aggressive/.test(textLower)) {
                            checkType = 'aggressive'; attrName = 'strength';
                        } else if (/[避躲藏防守等走避忍低觀察盯]/.test(t) || /hide|sneak|dodge|wait|guard|observe|cautious/.test(textLower)) {
                            checkType = 'cautious'; attrName = 'vitality';
                        } else if (/[研究解剖析讀用學法咒智慧具理思考]/.test(t) || /study|analyze|read|spell|device|hack|tool|smart|intelligent/.test(textLower)) {
                            checkType = 'smart'; attrName = 'dexterity';
                        } else if (/[說談騙服社交話交涉親善盟魅力]/.test(t) || /talk|persuade|deceive|negotiate|charm|npc|social/.test(textLower)) {
                            checkType = 'social'; attrName = 'charisma';
                        } else {
                            const idx = sum % 4;
                            if (idx === 0) { checkType = 'aggressive'; attrName = 'strength'; }
                            else if (idx === 1) { checkType = 'cautious'; attrName = 'vitality'; }
                            else if (idx === 2) { checkType = 'smart'; attrName = 'dexterity'; }
                            else { checkType = 'social'; attrName = 'charisma'; }
                        }
                        const chapter = playerState.camp_state?.chapter || 1;
                        DC = 8 + (chapter * 2);
                    }
                }

                if (isChecking) {
                    // 1. Calculate Attribute Value & Modifier
                    let attrVal = 10;
                    if (playerState.player_status?.attributes) {
                        if (attrName === 'charisma') {
                            const vit = playerState.player_status.attributes.vitality || 10;
                            const dex = playerState.player_status.attributes.dexterity || 10;
                            attrVal = playerState.player_status.attributes.charisma || Math.round((vit + dex) / 2);
                        } else {
                            attrVal = playerState.player_status.attributes[attrName] || 10;
                        }
                    }
                    const modifier = Math.floor((attrVal - 10) / 2);

                    // 2. Check Inventory Item Bonus
                    let hasItem = false;
                    let itemBonus = 0;
                    if (playerState.player_status?.inventory) {
                        if (requiredItem) {
                            hasItem = playerState.player_status.inventory.some(item => {
                                const name = typeof item === 'string' ? item : (item.name || '');
                                return name.toLowerCase().includes((requiredItem || '').toLowerCase());
                            });
                            itemBonus = hasItem ? 3 : 0;
                        } else {
                            // Automatic thematic items check
                            const invStr = JSON.stringify(playerState.player_status.inventory).toLowerCase();
                            if (attrName === 'strength' && (invStr.includes('劍') || invStr.includes('刀') || invStr.includes('斧') || invStr.includes('棍') || invStr.includes('sword') || invStr.includes('axe') || invStr.includes('weapon'))) {
                                itemBonus = 2;
                            } else if (attrName === 'vitality' && (invStr.includes('盾') || invStr.includes('甲') || invStr.includes('藥') || invStr.includes('水') || invStr.includes('armor') || invStr.includes('shield') || invStr.includes('potion'))) {
                                itemBonus = 2;
                            } else if (attrName === 'dexterity' && (invStr.includes('工具') || invStr.includes('鎖') || invStr.includes('錶') || invStr.includes('卷') || invStr.includes('書') || invStr.includes('tool') || invStr.includes('scroll') || invStr.includes('key'))) {
                                itemBonus = 2;
                            } else if (attrName === 'charisma' && (invStr.includes('戒') || invStr.includes('鍊') || invStr.includes('信') || invStr.includes('徽') || invStr.includes('pendant') || invStr.includes('badge') || invStr.includes('ring'))) {
                                itemBonus = 2;
                            }
                        }
                    }

                    // 3. Status Bonuses/Penalties
                    let statusPenalty = 0;
                    const stamina = playerState.world_state?.stamina !== undefined ? playerState.world_state.stamina : 100;
                    if (stamina < 30) statusPenalty -= 2;
                    
                    const spBar = playerState.player_status?.status_bars?.find(b => b.type === 'sp');
                    if (spBar && spBar.value <= 0) statusPenalty -= 4;

                    // 4. Roll d20 & Calculate Final Score
                    const roll = Math.floor(Math.random() * 20) + 1;
                    const score = roll + modifier + itemBonus + statusPenalty;

                    // 5. Determine 5 Outcome Tiers
                    let tier = 'Success';
                    let tierZh = '成功 (Success)';

                    if (roll === 20 || score >= DC + 6) {
                        tier = 'CriticalSuccess';
                        tierZh = '大成功 (Critical Success)';
                    } else if (roll === 1 || score < DC - 7) {
                        tier = 'CriticalFailure';
                        tierZh = '大失敗 (Critical Failure)';
                    } else if (score >= DC) {
                        tier = 'Success';
                        tierZh = '成功 (Success)';
                    } else if (score >= DC - 3) {
                        tier = 'BarelySuccess';
                        tierZh = '勉強成功 (Barely Success)';
                    } else {
                        tier = 'Failure';
                        tierZh = '失敗 (Failure)';
                    }

                    // 6. Update NPC Favors
                    if (requiredNPC) {
                        if (!playerState.world_state.npc_favor) playerState.world_state.npc_favor = {};
                        if (playerState.world_state.npc_favor[requiredNPC] === undefined) {
                            playerState.world_state.npc_favor[requiredNPC] = 0;
                        }
                        if (tier === 'CriticalSuccess') playerState.world_state.npc_favor[requiredNPC] += 10;
                        else if (tier === 'Success') playerState.world_state.npc_favor[requiredNPC] += 5;
                        else if (tier === 'Failure') playerState.world_state.npc_favor[requiredNPC] -= 5;
                        else if (tier === 'CriticalFailure') playerState.world_state.npc_favor[requiredNPC] -= 15;
                    }

                    // 7. Record to Decisions History
                    if (!playerState.world_state.decisions) playerState.world_state.decisions = [];
                    playerState.world_state.decisions.push({
                        action: checkAction,
                        text: checkText,
                        result: tierZh,
                        roll: `d20:${roll} + Mod:${modifier} + Item:${itemBonus} + State:${statusPenalty} = ${score} vs DC:${DC}`,
                        turn: playerState.world_state.decisions.length + 1
                    });

                    // 8. Construct Authoritative Prompts
                    const typeLabels = { aggressive: '激進 (Aggressive)', cautious: '謹慎 (Cautious)', smart: '智慧 (Intelligent)', social: '社交 (Social)' };
                    const typeLabel = typeLabels[checkType] || checkType;

                    sysMessage = `
🔴 SYSTEM AUTHORITATIVE OUTCOME DETERMINATION (CRITICAL DO NOT CHANGE) 🔴
The player executed action/choice: "${checkText}"
The backend has run the dice roll challenge with the following authoritative results:
- Action Type Group: "${typeLabel}"
- d20 rolled: ${roll}
- Checked Attribute: "${attrName}" (Player Value: ${attrVal}, Modifier: +${modifier})
- Inventory Item Assist Bonus: +${itemBonus}
- State Penalties (Stamina/SP): ${statusPenalty}
- Challenge Target (DC): ${DC}
- Final Calculated Score: ${score}
- **AUTHORITATIVE DETERMINED OUTCOME**: **${tier}** (${tierZh})

You MUST strictly adapt the narrative to conform to this outcome "**${tier}**" and update the JSON structure according to these rules:
1. **CriticalSuccess (大成功)**: Absolute perfect success. Highlight their expertise, describe a flawless outcome, provide a bonus item in "new_items" or high gold gain, and favorable NPC attitude.
2. **Success (成功)**: Clean standard success. They get exactly what they intended safely.
3. **BarelySuccess (勉強成功)**: Narrow escape. They achieve the goal, but pay a price. You MUST deduct 5-10 HP, SP, or MP in "status_updates" (e.g. { "name": "生命力", "change": -8 }) and describe their struggle.
4. **Failure (失敗)**: They fail. The situation worsens significantly. Deduct 15-20 HP or resources in "status_updates". Describe the painful setback, damage to gear, NPC hostility, or loss of items.
5. **CriticalFailure (大失敗)**: Utter disaster. Deduct 25-35 HP or trigger immediate combat with rank "Elite" or "Boss". Describe a serious injury, a major structural cave-in, gear breakage, or trap explosion.

Your JSON fields "status_updates", "new_items", "removed_items", "start_combat", etc., MUST match this outcome. Do NOT contradict this result in your story!
`;
                    outcomeCalculated = {
                        roll,
                        modifier,
                        itemBonus,
                        score,
                        DC,
                        tier,
                        tierZh,
                        checkType,
                        attrName
                    };

                    // Put the metadata in world_state so the client can display the dice outcome perfectly!
                    playerState.world_state.last_check_info = outcomeCalculated;
                }

                // C.2 生存資源每回合消耗與探索掉落判定 (Turn Decay & Resource Loop)
                const ws = playerState.world_state;
                const drainStamina = playerAction ? 10 : (selectedChoice ? 4 : 2);
                ws.stamina = Math.max(0, (ws.stamina !== undefined ? ws.stamina : 100) - drainStamina);
                ws.hunger = Math.max(0, (ws.hunger !== undefined ? ws.hunger : 100) - 2);
                ws.hydration = Math.max(0, (ws.hydration !== undefined ? ws.hydration : 100) - 2);

                if (ws.hunger <= 0) {
                    ws.survival_status = "STARVING";
                    let hpBar = playerState.player_status?.status_bars?.find(b => b.type === 'hp' || b.name === 'HP' || b.name === '生命值');
                    if (hpBar) hpBar.value = Math.max(1, (hpBar.value || 100) - 3);
                } else if (ws.hydration <= 0) {
                    ws.survival_status = "DEHYDRATED";
                } else if (ws.stamina <= 0) {
                    ws.survival_status = "EXHAUSTED";
                } else if (ws.hunger <= 20) {
                    ws.survival_status = "STARVING";
                } else if (ws.hydration <= 20) {
                    ws.survival_status = "DEHYDRATED";
                } else {
                    ws.survival_status = "NORMAL";
                }

                // Exploration or high success resource loot drop chance (40%)
                if (outcomeCalculated && (outcomeCalculated.tier === 'CriticalSuccess' || outcomeCalculated.tier === 'Success')) {
                    const isExploration = playerAction?.type === 'explore' || playerAction?.type === 'move' || (checkText && /[探索搜查找尋採勘]/.test(checkText));
                    if (isExploration && Math.random() < 0.45) {
                        const pool = ['food', 'water', 'wood', 'medicine'];
                        const weights = [0.35, 0.35, 0.25, 0.05];
                        const r = Math.random();
                        let cum = 0;
                        let gainedItem = 'food';
                        for (let idx = 0; idx < pool.length; idx++) {
                            cum += weights[idx];
                            if (r <= cum) { gainedItem = pool[idx]; break; }
                        }
                        if (!ws.resources) ws.resources = { food: 3, water: 3, wood: 3, medicine: 1 };
                        ws.resources[gainedItem] = (ws.resources[gainedItem] || 0) + 1;
                        playerState.world_state.last_looted_resource = gainedItem;
                    }
                }

                // D. 將世界狀態、決策歷史、好感度、據點與章節進度注入 AI 背景 Prompt 中
                const decisions = playerState.world_state.decisions || [];
                const npc_favor = playerState.world_state.npc_favor || {};
                const flags = playerState.world_state.flags || {};
                
                // Extract camp upgrades and chapter pacing metrics
                const camp = playerState.camp_state || { days: 1, chapter: 1, upgrades: { weapon: 0, armor: 0 }, blessings: [], unlocked_terminals: [] };
                const npcStates = playerState.npc_state || {};
                
                // Sync favors from npc_state to npc_favor for safety
                Object.keys(npcStates).forEach(npcKey => {
                    const n = npcStates[npcKey];
                    if (n && typeof n.favor === 'number') {
                        npc_favor[npcKey] = n.favor;
                    }
                });

                // Auto-sync player state's NPC favor and states to backend DB:
                const authHeader = req.headers['authorization'];
                const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
                if (token) {
                    syncNpcFavorToDb(token, npc_favor, npcStates);
                }

                // Construct active exploration framework prompt details
                let actionPrompt = "";
                if (playerAction) {
                    actionPrompt = `
--- CURRENT ACTIVE PLAYER ACTION ---
- Action Type: "${playerAction.type}"
- Action Target: "${playerAction.target || "None"}"
- Player Raw Input (if free text): "${playerAction.rawInput || ""}"

--- AI RESPONSIBILITIES IN THE ACTIVE EXPLORATION FRAMEWORK ---
1. You are responding directly to this ACTIVE player action. Describe the immediate narrative results and consequences of this specific action.
2. DO NOT decide the player's next move, actions, choices, or thoughts. Maintain player agency completely.
3. Reflect any changes in the updated "world_state" JSON block returned to the player (such as location, mode, stamina, quests, intel, etc.).
4. If you cannot understand the player's custom free input, or if it is entirely nonsensical/out-of-world, you MUST set the JSON field "unintelligible": true in the response, and explain why.
5. If the current scene allows story advancement, set "can_advance_campaign": true.
6. The "mode" should change automatically: set "mode": "剧情" if a critical story event/combat is triggered, or transition back to "mode": "自由" when a story sequence concludes.
`;
                }

                let companionPrompt = "";
                if (playerState.active_companion) {
                    const comp = playerState.active_companion;
                    companionPrompt = `
--- ACTIVE TRAVEL COMPANION (随行反差萌同伴) ---
- Name: "${comp.name}"
- Visual & Appearance: "${comp.visual || '🎒 随行伙伴'}"
- Archetype: "${comp.archetype || '萌系旅伴'}"
- Personality & Gap-Moe: "${comp.personality || '外冷内热，重度甜食控'}"
- Dialogue Quirk / Speaking Style: "${comp.dialogue_quirk || '口癖鲜明'}"
- Perk / Special Trait: "${comp.perk ? `${comp.perk.name} - ${comp.perk.description}` : '旅途互助'}"
- Affinity (好感度): ${comp.affinity || 20}/100

* COMPANION INTEGRATION RULES:
1. Integrate ${comp.name} naturally into the scene descriptions, dialogue banter, travel observations, or humorous reactions!
2. Reflect their unique dialogue quirk ("${comp.dialogue_quirk}") and gap-moe trait ("${comp.personality}").
3. In choices, provide at least one option that involves ${comp.name} (e.g., "[听听${comp.name}的看法]", "[与${comp.name}一起探索]", or companion-assisted action).
4. If the player interacts with or helps ${comp.name}, describe a cute/heartwarming moment.
`;
                }

                const narrativeTonePrompt = `
--- NARRATIVE TONE & PACING RULES (公路漫游与日常生活化叙事) ---
CRITICAL: Move away from pure high-anxiety survival disaster. Embrace a charming, atmospheric "Road Trip & Slice-of-Life" tone!
Target narrative focus balance:
1. [40% 探索发现与风土人情]: Depict the quiet beauty of ruins, golden sunset, gentle breeze, forgotten old-world relics, quirky landmarks, and cozy shelters.
2. [30% 营地日常与伙伴互动]: Depict camp life, brewing hot tea/coffee over a fire, sharing rations, comedic cooking attempts, traveling banter, and small comforting moments.
3. [20% 探索解谜与趣味互动]: Light scavenging, tinkering with eccentric broken machines, discovering old music players, chatting with neutral harmless wanderers.
4. [10% 遭遇战/危机]: Combat is NOT grinding or punishing; it serves only as a spice and a test of teamwork with the companion. NEVER trigger continuous malicious combat.
`;

                let historyPrompt = `
${narrativeTonePrompt}
${companionPrompt}
--- CAMP & PROGRESS WORLD STATE (CRITICAL CONTEXT) ---
- Current Mode: "${playerState.world_state.mode || "自由"}" (剧情/自由/过渡)
- Base Camp Status:
  * Current Location: "${playerState.world_state.location || "安全營地"}"
  * Time Tracker: "${playerState.world_state.time || "第 1 天"}"
  * Stamina Left: ${playerState.world_state.stamina !== undefined ? playerState.world_state.stamina : 100}/100
  * Known Intel/Secrets: ${JSON.stringify(playerState.world_state.intel || [])}
  * Active Quests: ${JSON.stringify(playerState.world_state.quests || [])}
  * Survival Days Elapsed: Day ${camp.days}
  * Active Story Chapter: Chapter ${camp.chapter}
  * Weapon Upgrade Level: +${camp.upgrades?.weapon || 0}
  * Armor Upgrade Level: +${camp.upgrades?.armor || 0}
  * Active Shrine Blessings: ${camp.blessings?.join(', ') || 'None'}
  * Old Terminals Unlocked: ${camp.unlocked_terminals?.length || 0}/3
- NPC Relationships (Favor & Alliances):
${Object.entries(npc_favor).map(([npc, val]) => {
    let tierText = 'Cold (No discounts, distant dialogue)';
    if (val >= 90) tierText = 'Sworn Ally (30% discount on services/goods, deeply loyal)';
    else if (val >= 60) tierText = 'Trusted (20% discount, friendly dialogue)';
    else if (val >= 30) tierText = 'Friendly (10% discount, warm dialogue)';
    return `  * ${npc}: ${val}% favorability [Tier: ${tierText}]`;
}).join('\n') || '  * (No custom NPC favor record yet)'}

- Past Choices & Outcomes:
${decisions.map(d => `  * Turn ${d.turn}: "${d.text}" -> ${d.result} (${d.roll})`).join('\n') || '  * (No actions recorded yet)'}
- World Flags (Active states):
${Object.entries(flags).map(([f, val]) => `  * Flag [${f}]: ${val}`).join('\n') || '  * (No world flags active yet)'}

${actionPrompt}

Please reflect the player's Chapter Progress, Weapon/Armor tier, Active Blessings, Companion bond, and NPC relationship levels directly in the narrative events, dialogue variations, merchant pricing offers, and challenge outcomes!
--------------------------------------------
`;
                // E. Intercept Minigame Finished prompts to enforce authoritative outcomes!
                if (prompt && prompt.includes('Mini-Game Finished')) {
                    const isWin = prompt.includes('Result: WIN');
                    const isLose = prompt.includes('Result: LOSE');
                    const mgTypeMatch = prompt.match(/Type:\s*([a-zA-Z_0-9]+)/);
                    const mgType = mgTypeMatch ? mgTypeMatch[1] : 'unknown';

                    if (isLose) {
                        sysMessage = `
🔴 SYSTEM AUTHORITATIVE MINIGAME FAILURE ENFORCEMENT (CRITICAL DO NOT OVERWRITE) 🔴
The player has FAILED the mini-game challenge of type: "${mgType}".
You are STRICTLY FORBIDDEN from writing any narrative of success or allowing the player to open/pass/solve the lock/safe/hazard.
You MUST write a narrative where the player FAILS, faces severe setbacks or negative consequences, and is forced to try another path or accept the penalty.
Apply negative state updates in your JSON "status_updates" (e.g. deduct HP, MP, or Gold based on the genre and situation).
`;
                    } else if (isWin) {
                        sysMessage = `
🔴 SYSTEM AUTHORITATIVE MINIGAME VICTORY ENFORCEMENT (CRITICAL DO NOT OVERWRITE) 🔴
The player has successfully WON the mini-game challenge of type: "${mgType}".
You MUST write a narrative of clean, satisfying victory where they unlock the safe, retrieve the treasure, bypass the trap, or overcome the hazard.
Add the earned rewards or items into "new_items" or "status_updates" (e.g. adding gold, keys, or rare weapons).
`;
                    }
                }

                prompt = historyPrompt + (sysMessage ? sysMessage + "\n" : "") + prompt;
            }

            const successResponse = (contentStr) => {
                let parsed = null;
                let isUnintelligible = false;

                try {
                    let jsonText = contentStr.trim();
                    const jsonBlockMatch = jsonText.match(/```json\s*([\s\S]*?)\s*```/);
                    if (jsonBlockMatch) {
                        jsonText = jsonBlockMatch[1];
                    } else {
                        const objectMatch = jsonText.match(/\{[\s\S]*\}/);
                        if (objectMatch) {
                            jsonText = objectMatch[0];
                        }
                    }
                    parsed = JSON.parse(jsonText);
                } catch (e) {
                    console.warn("[Backend] AI response was not valid JSON, or failed to parse:", e);
                }

                if (parsed) {
                    if (parsed.unintelligible === true || parsed.unintelligible === "true") {
                        isUnintelligible = true;
                    }

                    if (playerState && playerState.world_state) {
                        if (parsed.world_state) {
                            Object.assign(playerState.world_state, parsed.world_state);
                        }
                        if (parsed.mode) {
                            playerState.world_state.mode = parsed.mode;
                        }
                        if (parsed.can_advance_campaign !== undefined) {
                            playerState.world_state.can_advance_campaign = !!parsed.can_advance_campaign;
                        }
                    }
                }

                if (isUnintelligible && playerState) {
                    const lang = playerState.language || body.language || 'zh-TW';
                    let errorMsg = "🧐 無法理解您的冒險意圖，請試著換種說法或嘗試其他動作。";
                    if (lang.toLowerCase().includes('en')) {
                        errorMsg = "🧐 Could not understand your action. Please try rephrasing or choose a different action.";
                    } else if (lang.toLowerCase().includes('ja') || lang.toLowerCase().includes('jp')) {
                        errorMsg = "🧐 行動の意図が理解できませんでした。別の表現を試すか、他の行動を選択してください。";
                    }

                    const structuredResponse = {
                        narrative: errorMsg,
                        turn_summary: "Action unintelligible",
                        unintelligible: true,
                        error_message: errorMsg,
                        status_updates: [],
                        world_state: playerState.world_state
                    };

                    return sendJson(res, 200, {
                        success: true,
                        content: JSON.stringify(structuredResponse),
                        unintelligible: true,
                        error_message: errorMsg,
                        outcomeCalculated,
                        playerState
                    });
                }

                return sendJson(res, 200, { 
                    success: true, 
                    content: contentStr,
                    outcomeCalculated,
                    playerState
                });
            };

            // 智能判断 Key 类型：
            // A. Google 官方原生 Key (以 AIzaSy 开头)
            if (activeKey.startsWith('AIzaSy')) {
                const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${activeKey}`;
                const payload = {
                    contents: [{ parts: [{ text: prompt }] }]
                };
                if (safetySettings) payload.safetySettings = safetySettings;

                const response = await fetch(targetUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    const errText = await response.text();
                    return sendError(res, response.status, `Google API 错误: ${errText}`);
                }

                const result = await response.json();
                const content = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
                return successResponse(content);
            }

            // B. 针对第三方转发、OpenAI 格式或代理 Key (例如用户提供的 AQ.Ab8... / sk-...)
            const proxyBase = dbCache.settings.custom_proxy_url || 'https://generativelanguage.googleapis.com';
            
            // 尝试 1: 如果是第三方代理兼容 OpenAI Chat Completions 规范
            if (proxyBase.includes('/v1') || activeKey.startsWith('sk-') || activeKey.startsWith('AQ.')) {
                let openaiEndpoint = proxyBase.endsWith('/') ? `${proxyBase}chat/completions` : `${proxyBase}/chat/completions`;
                if (!proxyBase.includes('/v1')) {
                    openaiEndpoint = 'https://api.openai.com/v1/chat/completions';
                }

                try {
                    const response = await fetch(openaiEndpoint, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${activeKey}`
                        },
                        body: JSON.stringify({
                            model: activeModel.includes('gemini') ? 'gpt-4o-mini' : activeModel,
                            messages: [{ role: 'user', content: prompt }],
                            temperature: 0.7
                        })
                    });

                    if (response.ok) {
                        const result = await response.json();
                        const content = result.choices?.[0]?.message?.content || '';
                        return successResponse(content);
                    }
                } catch (e) {
                    console.warn('OpenAI proxy attempt failed, falling back to direct gemini fetch:', e.message);
                }
            }

            // 尝试 2: 标准带 Header 转发 Gemini API
            const directGeminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent`;
            const geminiRes = await fetch(directGeminiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': activeKey
                },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                })
            });

            if (!geminiRes.ok) {
                const errText = await geminiRes.text();
                return sendError(res, geminiRes.status, `AI 生成失败 (${geminiRes.status}): ${errText}`);
            }

            const geminiData = await geminiRes.json();
            const geminiContent = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
            return successResponse(geminiContent);

        } catch (e) {
            return sendError(res, 500, 'AI 网关转发异常: ' + e.message);
        }
    }

    // ==========================================
    // 5. 静态资源托管服务 (Static File Server)
    // ==========================================
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

    // 快捷路由: /admin 直接映射到 /admin.html
    if (pathname === '/admin') {
        filePath = path.join(PUBLIC_DIR, 'admin.html');
    }

    // 安全检查，防止路径穿越
    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            // 404  fallback
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('404 Not Found');
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, { 'Content-Type': contentType });
        const readStream = fs.createReadStream(filePath);
        readStream.pipe(res);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`🚀 Text RPG Generator 服务启动成功!`);
    console.log(`🎮 游戏前台: http://localhost:${PORT}`);
    console.log(`🛠️ 管理后台: http://localhost:${PORT}/admin.html`);
    console.log(`🔑 默认管理员账号: admin / 密码: admin123456`);
    console.log(`=======================================================`);
});
