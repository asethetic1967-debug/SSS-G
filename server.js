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

            const companionPrompt = `You are an expert game narrative and character designer specialized in creating captivating, charming, and memorable "Bishoujo & Gap-Moe Heroines" (高魅力美少女/反差萌女伴) for a story-rich adventure RPG.
Genre: ${genre}
Player Character: ${characterDesc || 'A wandering traveler'}
Language: ${language === 'zh-TW' ? '繁體中文' : (language === 'ja' ? '日本語' : (language === 'zh-CN' ? '简体中文' : 'English'))}

Generate ONE distinctive, attractive heroine companion who encounters and accompanies the player on their journey.
Requirements:
1. **Name**: Memorable heroine name (e.g. 希尔薇娅, 楚云裳, 蕾娜, 珀莉, 克洛伊, 夜凰, 米娅, 艾莉诺).
2. **Archetype**: Engaging anime/galgame/RPG heroine archetype (e.g., 傲娇双马尾机械工匠 / 银发冷艳三无近卫 / 妩媚撩人神秘医仙 / 清冷出尘剑仙师姐 / 元气兽耳弓手 / 赛博魅影叛逆黑客 / 战力爆表龙角少女).
3. **Visual**: 1 representative Emoji + vivid aesthetic appearance description (e.g., "❄️ 银白长发与修身皮革战斗服，白皙脸颊在冷风中透着淡淡绯红", "🗡️ 素白剑袍与墨玉发簪，身姿曼妙出尘，腰悬青霜古剑", "🦊 蓬松毛茸茸狐耳与灵动兽尾，眼眸清澈明亮，身穿轻便游侠短裙").
4. **Personality**: Core charm + distinctive gap-moe quirk & romantic tension (e.g., "外表高傲毒舌其实极易害羞脸红，被夸奖时会慌乱整理裙摆", "平日清冷寡言，但在二人独处或营火夜谈时会流露温柔脆弱的一面", "看似从容魅惑的大姐姐，遇到心动时刻反倒会心跳加速不敢直视").
5. **Dialogue Quirk**: Distinctive speaking habit/quirk with romantic/banter tone (e.g., 傲娇娇嗔吐槽、轻声细语中带着温柔依恋、调皮挑逗却又在关键时刻脸红).
6. **Meet Scene**: A memorable, charming encounter with romantic/comedic tension (e.g., 遭遇机关时跌入主角怀中脸红对视、在清泉边洗浴后慌乱穿上衣衫、战斗中被主角援手后别扭道谢).
7. **Perk**: { "name": "特技名称", "description": "探索/战斗/营地专属增益（如：贴心包扎回复翻倍、废墟搜刮稀有道具、危机舍身护佑）" }.
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
                        name: "希尔薇娅 (Sylvia)",
                        archetype: "银发三无冷艳护卫",
                        visual: "❄️ 银白披肩长发与漆黑战术风衣，清澈冰蓝眼眸中藏着不易察觉的温柔",
                        personality: "平时寡言冷静像一柄出鞘利刃，但独处时只要被盯着看就会耳尖微红，默默握紧刀柄掩饰害羞",
                        dialogue_quirk: "言简意赅，偶尔在主角受伤时会焦急地轻咬下唇：「……别乱动，让我处理。」",
                        meet_scene: "在废弃列车顶端斩杀围攻的机械兽，战斗风衣在暴风中轻扬，转身与主角目光交汇时微微一怔",
                        perk: { name: "霜刃守护", description: "营地休息时夜袭概率降为0，陷入危机时必定触发舍身格挡救助" },
                        affinity: 20
                    },
                    {
                        name: "克洛伊 (Chloe)",
                        archetype: "傲娇双马尾机械魔女",
                        visual: "🔧 金色双马尾、护目镜与贴身工装皮裙，雪白大腿上绑着精密的微型工具包",
                        personality: "嘴硬心软极易害羞，自称全大陆第一天才，被主角真诚夸奖时会脸红结巴并慌张拉下护目镜",
                        dialogue_quirk: "「哼！才、才不是特意为你改良的武器！只是本小姐看不过去粗制滥造而已啦！」",
                        meet_scene: "正在狭窄的废墟通道调试机械核心，不小心触发警报整个人跌入主角怀中，近距离心跳对视",
                        perk: { name: "超频改装", description: "所有装备改装强化费用降低30%，废墟搜刮时极高概率发现稀有机械核心" },
                        affinity: 20
                    },
                    {
                        name: "楚云裳 (Chu Yunshang)",
                        archetype: "清冷出尘剑仙师姐",
                        visual: "🗡️ 素白如雪的凌波剑袍，墨发如瀑，腰若流纨素，一双秋水明眸顾盼生辉",
                        personality: "剑道天资绝顶，外表清冷如高岭之花，但在营火夜谈时会褪去防备，轻抚古剑吐露少女心事",
                        dialogue_quirk: "声如碎玉清冷婉转，情绪悸动时会垂下眼帘轻唤主角名字：「……师弟/道友，莫要这般看我。」",
                        meet_scene: "在竹林残阳下仗剑破敌，月白衣袂在剑气中翻飞，收剑入鞘时发丝拂过主角面颊，带起一缕冷香",
                        perk: { name: "剑心通明", description: "洞察敌人弱点使暴击率提升25%，修炼与冥想时真气精力恢复翻倍" },
                        affinity: 20
                    },
                    {
                        name: "夜凰 (Ye Huang)",
                        archetype: "妩媚撩人神秘医仙",
                        visual: "🍷 绯红暗纹开衩锦袍与轻柔紫纱，身姿曼妙妖娆，指尖萦绕着治愈与蛊毒的幽光",
                        personality: "喜欢轻言调笑的主动大姐姐，言语间带着令人心跳加速的暧昧，实则对待感情至情至性且极度护短",
                        dialogue_quirk: "尾音微扬带着慵懒媚意：「小家伙，这伤口若是再深半寸……姐姐可是会心疼的呢。」",
                        meet_scene: "在幽暗茶肆的软榻上倚案品茗，纤细手腕轻轻托腮，在主角被追兵包围时掷出毒针解围",
                        perk: { name: "回春妙手", description: "所有治疗药剂与包扎回复效果提升60%，且能驱散所有剧毒与负面异常" },
                        affinity: 20
                    },
                    {
                        name: "米娅 (Mia)",
                        archetype: "元气纯情狐耳游侠",
                        visual: "🦊 毛茸茸的雪白狐耳与蓬松灵动大尾巴，身着轻便短猎装，腰间挂着精致的木雕风铃",
                        personality: "天真烂漫充满治愈感，对主角全心全意依赖，害羞或开心时头顶毛茸茸的狐耳会随心情剧烈晃动",
                        dialogue_quirk: "声音清脆甜美：「今天也要一直跟在主人身边！米娅会把最甜的浆果都留给您！」",
                        meet_scene: "被困在古代猎人捕兽网中拼命挣扎，被主角解救后紧紧抱住主角手臂不肯松开",
                        perk: { name: "灵狐嗅觉", description: "野外探索必定发现隐藏秘境与甘泉，采集草药与食材收获量翻倍" },
                        affinity: 20
                    },
                    {
                        name: "蕾娜 (Reina)",
                        archetype: "赛博魅影叛逆黑客",
                        visual: "⚡ 荧光粉挑染短发与贴身发光机能服，修长锁骨与细腰处勾勒着流光义体纹路",
                        personality: "性格狂放不羁且带着恶作剧属性，在战场上雷厉风行，但在狭窄安全屋靠在一起时会露出依恋眼神",
                        dialogue_quirk: "嚼着泡泡糖轻笑：「数据流已经锁定了。喂，搭档，今晚的战利品分我一半，外加你的肩膀借我靠一小时。」",
                        meet_scene: "在霓虹闪烁的暗巷中黑入企业炮塔救下主角，二人背靠背在子弹雨中共享同一个神经链接耳机",
                        perk: { name: "神经同步", description: "所有电子门锁与终端直接秒解，黑客入侵DC判定直接豁免" },
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

            const genre = (playerState?.world_theme || playerState?.genre || playerState?.game_genre || '').toLowerCase();
            const location = playerState?.world_state?.location || '周遭區域';
            const zoneType = playerState?.explore_state?.zone_type || 'safe';

            // Multi-genre dynamic POI templates
            const genrePoiMap = {
                wuxia: {
                    chest: [
                        { id: 'wx_chest_1', name_zh: '荒廢神龕下的雕花木匣', name_en: 'Carved Wooden Box under Altar', name_ja: '荒れた祠の彫刻木箱', type: 'chest', minigame: 'scratch', desc_zh: '半掩在蒲團底下的沉木匣子，隱約有金屬搭扣痕跡。', desc_en: 'A heavy wooden box hidden under prayer mats.', desc_ja: '座布団の下に隠された重厚な木箱。', danger_rating: 10 },
                        { id: 'wx_chest_2', name_zh: '折斷的鏢車暗格', name_en: 'Hidden Escort Wagon Compartment', name_ja: '壊れた護送車の隠し扉', type: 'chest', minigame: 'popup', desc_zh: '遺棄在路旁的運鏢馬車，底層夾板內藏有機關暗鎖。', desc_en: 'An abandoned escort wagon with a trapped hidden compartment.', desc_ja: '放棄された護送馬車。底部に罠付きの隠し棚がある。', danger_rating: 25 }
                    ],
                    corpse: [
                        { id: 'wx_corpse_1', name_zh: '路旁歇息倒斃的江湖客', name_en: 'Fallen Swordsman Remains', name_ja: '倒れた武芸者の遺骸', type: 'corpse', minigame: 'scratch', desc_zh: '倚靠在巨石旁的黑衣俠客，腰間尚有隨身革囊與佩劍。', desc_en: 'A fallen swordsman resting by a boulder, carrying gear.', desc_ja: '大岩の脇に倒れた武芸者。革袋と帯刀が残されている。', danger_rating: 15 },
                        { id: 'wx_corpse_2', name_zh: '伏誅的綠林草寇殘骸', name_en: 'Defeated Bandit Remains', name_ja: '討たれた山賊の亡骸', type: 'corpse', minigame: 'scratch', desc_zh: '遭人一劍封喉的劫道山匪，身上似乎搜刮了不少過路碎銀。', desc_en: 'A fallen highwayman likely carrying looted coins and daggers.', desc_ja: '討伐された山賊。通行人から奪った小銭を持っていそうだ。', danger_rating: 20 }
                    ],
                    ruins: [
                        { id: 'wx_ruins_1', name_zh: '崩塌的山道古亭瓦礫', name_en: 'Rubble of Mountain Pavilion', name_ja: '崩れた山道の東屋跡', type: 'ruins', minigame: 'dig', desc_zh: '被風雨摧折的涼亭廢墟，石柱縫隙間可能生長著野生靈草。', desc_en: 'Collapsed mountain rest pavilion where wild herbs or tools might grow.', desc_ja: '風雨で崩れた東屋。岩の隙間に野草や道具が埋もれているかも。', danger_rating: 10 },
                        { id: 'wx_ruins_2', name_zh: '荒廢義莊的積塵後室', name_en: 'Dusty Chamber of Abandoned Manor', name_ja: '廃屋の奥の間', type: 'ruins', minigame: 'dig', desc_zh: '門戶歪斜的舊時代瓦舍，磚瓦下藏著昔日主人埋藏的陶罐。', desc_en: 'Old brick ruins with buried urns and preserved tonics.', desc_ja: '崩れかけた古民家。陶器の壺が埋まっているかもしれない。', danger_rating: 25 }
                    ],
                    shelf: [
                        { id: 'wx_shelf_1', name_zh: '荒店積灰的酒架', name_en: 'Dusty Tavern Liquor Shelf', name_ja: '寂れた宿場の酒棚', type: 'shelf', minigame: 'scratch', desc_zh: '廢棄驛站內的木架，上面殘存著幾罈未開封的老酒與粗碗。', desc_en: 'Shelves in an abandoned relay tavern with sealed jugs and supplies.', desc_ja: '廃宿の木棚。未開封の酒壺や乾物資が残されている。', danger_rating: 10 }
                    ]
                },
                xianxia: {
                    chest: [
                        { id: 'xx_chest_1', name_zh: '古修遺留的禁制石匣', name_en: 'Ancient Cultivator Stone Box', name_ja: '古修の封印石函', type: 'chest', minigame: 'scratch', desc_zh: '刻滿流轉符文的靈玉石匣，散發著微弱靈力波動。', desc_en: 'A jade box inscribed with fading runes.', desc_ja: '微かな霊気を放つルーン刻印の玉匣。', danger_rating: 20 }
                    ],
                    corpse: [
                        { id: 'xx_corpse_1', name_zh: '坐化修士的枯骨儲物袋', name_en: 'Meditator Remains & Storage Pouch', name_ja: '座化修道士の遺骸と収納袋', type: 'corpse', minigame: 'scratch', desc_zh: '在石壁前羽化的前輩殘骨，腰間掛著褪色的乾坤錦囊。', desc_en: 'Bones of an ancient cultivator holding a worn spatial pouch.', desc_ja: '静かに座化を遂げた先人の遺骨。帯に収納袋が残る。', danger_rating: 25 }
                    ],
                    ruins: [
                        { id: 'xx_ruins_1', name_zh: '枯竭靈泉邊的伴生靈草叢', name_en: 'Drained Spirit Spring Herb Patch', name_ja: '霊泉跡の薬草群生', type: 'ruins', minigame: 'dig', desc_zh: '雖靈氣已微，但泉眼碎石堆中仍孕育著百年靈植。', desc_en: 'A rocky spring basin where precious herbs still sprout.', desc_ja: '霊気が薄れた泉跡。貴重な霊草が根を張っている。', danger_rating: 15 }
                    ],
                    shelf: [
                        { id: 'xx_shelf_1', name_zh: '煉丹殘室的藥材玉架', name_en: 'Alchemy Chamber Jade Shelf', name_ja: '錬丹室の薬材棚', type: 'shelf', minigame: 'scratch', desc_zh: '散落著碎裂瓷瓶與乾枯靈植的置物架。', desc_en: 'A shelf of jade flasks and dried alchemical ingredients.', desc_ja: '砕けた薬瓶と乾燥霊草が散乱する棚。', danger_rating: 15 }
                    ]
                },
                cyberpunk: {
                    chest: [
                        { id: 'cb_chest_1', name_zh: '短路的黑市晶片箱', name_en: 'Short-Circuited Chip Case', name_ja: 'ショートした闇市チップケース', type: 'chest', minigame: 'scratch', desc_zh: '帶有生物辨識鎖的改裝保險盒，外殼閃爍著微弱電弧。', desc_en: 'A modded safe with a flickering biometric latch.', desc_ja: '放電している生体認証付きセーフボックス。', danger_rating: 25 }
                    ],
                    corpse: [
                        { id: 'cb_corpse_1', name_zh: '義體過載的街頭黑客骸體', name_en: 'Overloaded Netrunner Remains', name_ja: 'オーバーヒートしたハッカーの遺体', type: 'corpse', minigame: 'scratch', desc_zh: '倒在暗巷垃圾堆旁的流浪者，體內裝載著可回收的神經義件。', desc_en: 'A deceased netrunner in an alley with salvageable cyberware.', desc_ja: '裏路地に倒れたハッカー。回収可能な義体パーツが残る。', danger_rating: 20 }
                    ],
                    ruins: [
                        { id: 'cb_ruins_1', name_zh: '廢棄改裝診所的儀器堆', name_en: 'Abandoned Ripperdoc Scrap Pile', name_ja: '違法診療所のジャンク山', type: 'ruins', minigame: 'dig', desc_zh: '堆滿廢舊冷卻管、電路板與生化凝膠的診所廢墟。', desc_en: 'Piles of bio-gel, coolant tubes, and discarded processors.', desc_ja: '冷却チューブや基板、生体ゲルが散乱する廃墟。', danger_rating: 15 }
                    ],
                    shelf: [
                        { id: 'cb_shelf_1', name_zh: '斷電便利店的自動貨架', name_en: 'Powered-down Vendor Shelf', name_ja: '電源の切れた自販棚', type: 'shelf', minigame: 'scratch', desc_zh: '無人商店殘留的合成口糧與能量補給包。', desc_en: 'Nutrient paste and energy cells remaining in a dark shop.', desc_ja: '合成食料やバッテリーが残る無人店舗の棚。', danger_rating: 10 }
                    ]
                },
                default: {
                    chest: [
                        { id: 'chest_1', name_zh: '生鏽的金屬儲物箱', name_en: 'Rusted Metal Chest', name_ja: '錆びた金属の保管箱', type: 'chest', minigame: 'scratch', desc_zh: '鎖頭有些鬆動的堅固金屬箱，裡面可能保存著完好的補給物資。', desc_en: 'A solid metal box with a loose latch, likely containing rations or supplies.', desc_ja: '留め具が緩んだ頑丈な金属箱。保存食などの物資が入っていそうだ。', danger_rating: 15 },
                        { id: 'chest_2', name_zh: '鎖死的旅行皮箱', name_en: 'Locked Leather Travel Trunk', name_ja: '施錠された革製トランク', type: 'chest', minigame: 'popup', desc_zh: '用黃銅鎖扣扣緊的厚實皮箱，隱約能聽見內部金幣晃動聲。', desc_en: 'A sturdy leather trunk locked tight.', desc_ja: '頑丈な革のトランク。金貨の擦れる音がする。', danger_rating: 20 }
                    ],
                    corpse: [
                        { id: 'corpse_1', name_zh: '倒斃的前探索者遺骸', name_en: 'Fallen Explorer Remains', name_ja: '倒れた探索者の遺骸', type: 'corpse', minigame: 'scratch', desc_zh: '倒在角落的旅行者，身上還掛著隨身行囊與武器配件。', desc_en: 'A traveler slumped in the corner, carrying gear and weapon accessories.', desc_ja: '物陰に倒れた旅人。まだ装備や武器パーツを身につけている。', danger_rating: 20 },
                        { id: 'corpse_2', name_zh: '野獸獵殺後的行囊殘留', name_en: 'Beast-Scattered Travel Bag', name_ja: '獣に荒らされた荷物袋', type: 'corpse', minigame: 'scratch', desc_zh: '被野獸撕裂的行李袋，四周散落著乾糧與防身小刀。', desc_en: 'Torn travel pack with rations and tools scattered about.', desc_ja: '引き裂かれた鞄の周りに乾パンと小刀が散らばっている。', danger_rating: 25 }
                    ],
                    ruins: [
                        { id: 'ruins_1', name_zh: '半掩埋的建築瓦礫堆', name_en: 'Buried Rubble Mound', name_ja: '半埋没の瓦礫の山', type: 'ruins', minigame: 'dig', desc_zh: '散落著磚石與木構件的殘骸，翻開深處可能找到實用材料。', desc_en: 'Piled masonry and scraps. Digging deep may uncover valuable components.', desc_ja: '石と木片が散らばる瓦礫。掘り起こせば素材が見つかるかも。', danger_rating: 15 }
                    ],
                    shelf: [
                        { id: 'shelf_1', name_zh: '積灰的物資貨架', name_en: 'Dusty Supply Shelf', name_ja: '埃をかぶった物資棚', type: 'shelf', minigame: 'scratch', desc_zh: '上面雜亂地擺放著各種日用補給與雜物。', desc_en: 'Rations and miscellaneous goods scattered on old shelves.', desc_ja: '日用雑品や保存食が無造作に並んでいる。', danger_rating: 10 }
                    ]
                }
            };

            let matchedCategory = 'default';
            if (genre.includes('武俠') || genre.includes('wuxia') || genre.includes('江湖')) matchedCategory = 'wuxia';
            else if (genre.includes('仙俠') || genre.includes('xianxia') || genre.includes('修真') || genre.includes('玄幻')) matchedCategory = 'xianxia';
            else if (genre.includes('賽博') || genre.includes('cyber') || genre.includes('科幻') || genre.includes('sci')) matchedCategory = 'cyberpunk';

            const activePoiTemplates = genrePoiMap[matchedCategory] || genrePoiMap.default;

            // Select 2-3 POIs randomly
            const pois = [];
            const types = Object.keys(activePoiTemplates);
            const count = Math.min(3, Math.floor(Math.random() * 2) + 2);
            for (let i = 0; i < count; i++) {
                const t = types[i % types.length];
                const pool = activePoiTemplates[t] || activePoiTemplates.chest || genrePoiMap.default.chest;
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
                locationName: location,
                message: isEn ? `Discovered ${pois.length} search points at ${location}.` : isJa ? `【${location}】で${pois.length}箇所の探索ポイントを発見しました。` : `在當前【${location}】發現了 ${pois.length} 處可供搜刮的目標點。`
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
                        : '❌ 當前處於劇情引導或戰鬥受限狀態，無法進行搜刮！');
                }
            }

            const ws = playerState.world_state;
            const spCost = Math.min(10, Math.max(6, Math.floor((scratchPercent || 50) / 10)));
            ws.stamina = Math.max(0, (ws.stamina || 100) - spCost);
            playerState.stamina = ws.stamina;
            
            // Normalize & deduct SP from appropriate status bar across all genres
            const spBar = playerState.player_status?.status_bars?.find(b => 
                b.type === 'sp' || 
                (b.name && (b.name.includes('精力') || b.name.includes('體力') || b.name.includes('氣力') || b.name.includes('耐力') || b.name.includes('身手')))
            );
            if (spBar) {
                spBar.value = Math.max(0, spBar.value - spCost);
                ws.stamina = spBar.value;
            }
            if (ws.stamina <= 0) {
                ws.survival_status = 'EXHAUSTED';
            }

            const genre = (playerState?.world_theme || playerState?.genre || playerState?.game_genre || '').toLowerCase();
            const isWuxia = genre.includes('武俠') || genre.includes('wuxia') || genre.includes('江湖');
            const isXianxia = genre.includes('仙俠') || genre.includes('xianxia') || genre.includes('修真') || genre.includes('玄幻');
            const isCyber = genre.includes('賽博') || genre.includes('cyber') || genre.includes('科幻') || genre.includes('sci');

            // Calculate loot yield based on POI type and reveal depth
            const percent = Math.min(100, Math.max(0, scratchPercent || 50));
            let riskIncrement = Math.floor(percent * 0.35) + Math.floor(Math.random() * 8);
            let trapTriggered = false;
            let trapDamage = 0;

            const lootTable = {
                chest: isWuxia ? [
                    { name_zh: '特製金創藥散', name_en: 'Refined Golden Wound Salve', name_ja: '特製金創薬', type: 'medicine', val: 1, rarity: 'common', depth: 20 },
                    { name_zh: '清冽山泉竹筒', name_en: 'Bamboo Spring Flask', name_ja: '竹筒の湧水', type: 'water', val: 1, rarity: 'common', depth: 30 },
                    { name_zh: '沉甸甸的紋銀布袋', name_en: 'Heavy Silver Pouch', name_ja: 'ずっしりとした銀貨袋', type: 'money_container', val: 30, rarity: 'uncommon', depth: 45 },
                    { name_zh: '精煉百煉鋼鐵錠', name_en: 'Tempered Steel Ingot', name_ja: '精錬された鋼鉄インゴット', type: 'material', val: 2, rarity: 'uncommon', depth: 60 },
                    { name_zh: '古舊的吐納殘篇', name_en: 'Ancient Breath-Cultivation Page', name_ja: '古びた呼吸法の断片', type: 'quest_item', val: 1, rarity: 'rare', depth: 80 }
                ] : isXianxia ? [
                    { name_zh: '回春散瓶', name_en: 'Rejuvenation Salve Bottle', name_ja: '回春薬瓶', type: 'medicine', val: 1, rarity: 'common', depth: 20 },
                    { name_zh: '下品靈石袋', name_en: 'Low-tier Spirit Stone Pouch', name_ja: '下品霊石の小袋', type: 'money_container', val: 25, rarity: 'uncommon', depth: 40 },
                    { name_zh: '百年野山參', name_en: 'Century Wild Ginseng', name_ja: '百年野山参', type: 'food', val: 1, rarity: 'uncommon', depth: 60 },
                    { name_zh: '玄鐵精金殘片', name_en: 'Black-Iron Metal Fragment', name_ja: '玄鉄の精金破片', type: 'material', val: 2, rarity: 'rare', depth: 80 }
                ] : isCyber ? [
                    { name_zh: '生化維生營養膏', name_en: 'Bio-Nutrient Paste', name_ja: '生体栄養ペースト', type: 'food', val: 1, rarity: 'common', depth: 20 },
                    { name_zh: '加密信用點晶片', name_en: 'Encrypted CredChip', name_ja: '暗号化クレジットチップ', type: 'money_container', val: 35, rarity: 'uncommon', depth: 40 },
                    { name_zh: '急救微型止血劑', name_en: 'Micro-Hemostatic Injector', name_ja: '応急止血インジェクター', type: 'medicine', val: 1, rarity: 'uncommon', depth: 55 },
                    { name_zh: '高純度散熱超頻凝膠', name_en: 'Overclock Thermal Gel', name_ja: '高純度オーバークロック冷却ゲル', type: 'material', val: 1, rarity: 'rare', depth: 80 }
                ] : [
                    { name_zh: '密封肉類罐頭', name_en: 'Sealed Meat Can', name_ja: '密封肉の缶詰', type: 'food', val: 1, rarity: 'common', depth: 20 },
                    { name_zh: '淨化水壺', name_en: 'Purified Water Flask', name_ja: '浄水フラスコ', type: 'water', val: 1, rarity: 'common', depth: 30 },
                    { name_zh: '沉甸甸的錢袋', name_en: 'Heavy Coin Pouch', name_ja: 'ずっしりとした金貨袋', type: 'money_container', val: 25, rarity: 'uncommon', depth: 40 },
                    { name_zh: '急救繃帶包', name_en: 'First Aid Bandages', name_ja: '応急包帯セット', type: 'medicine', val: 1, rarity: 'uncommon', depth: 55 },
                    { name_zh: '舊時代軍用口糧', name_en: 'Military MRE Pack', name_ja: '軍用MREレーション', type: 'food', val: 2, rarity: 'rare', depth: 80 }
                ],
                corpse: isWuxia ? [
                    { name_zh: '磨損的精鋼短匕', name_en: 'Steel Dagger', name_ja: '鋼の短剣', type: 'weapon', val: 1, rarity: 'common', depth: 25 },
                    { name_zh: '俠客隨身碎銀袋', name_en: 'Swordsman Coin Pouch', name_ja: '旅人の小銭入れ', type: 'money_container', val: 20, rarity: 'common', depth: 40 },
                    { name_zh: '護身熟牛皮內甲', name_en: 'Hardened Leather Vest', name_ja: '牛革の胸当て', type: 'armor', val: 1, rarity: 'uncommon', depth: 60 },
                    { name_zh: '精鋼佩劍 (+3)', name_en: 'Refined Steel Sword (+3)', name_ja: '精鋼の長剣 (+3)', type: 'weapon', val: 1, rarity: 'rare', depth: 80 }
                ] : [
                    { name_zh: '磨損的短匕首', name_en: 'Worn Dagger', name_ja: '使い古された短剣', type: 'weapon', val: 1, rarity: 'common', depth: 20 },
                    { name_zh: '死者錢包與碎銀', name_en: 'Purse & Silver Pieces', name_ja: '財布と銀貨', type: 'money_container', val: 15, rarity: 'common', depth: 35 },
                    { name_zh: '強化皮革護手', name_en: 'Reinforced Leather Bracers', name_ja: '強化革の篭手', type: 'armor', val: 1, rarity: 'uncommon', depth: 50 },
                    { name_zh: '生鏽的求生砍刀 (+2)', name_en: 'Rusted Machete (+2)', name_ja: '錆びたサバイバルナタ (+2)', type: 'weapon', val: 1, rarity: 'rare', depth: 75 }
                ],
                ruins: isWuxia ? [
                    { name_zh: '堅韌乾燥枯木', name_en: 'Seasoned Hardwood', name_ja: '乾燥した堅木', type: 'wood', val: 3, rarity: 'common', depth: 15 },
                    { name_zh: '山壁野生止血草', name_en: 'Wild Mountain Herb', name_ja: '山野の止血草', type: 'medicine', val: 2, rarity: 'common', depth: 35 },
                    { name_zh: '地底埋藏的古銅錢壺', name_en: 'Buried Copper Coin Pot', name_ja: '埋もれた古銅貨壺', type: 'money_container', val: 35, rarity: 'uncommon', depth: 65 },
                    { name_zh: '隕鐵礦石殘片', name_en: 'Meteorite Ore Fragment', name_ja: '隕鉄の鉱石破片', type: 'material', val: 1, rarity: 'rare', depth: 85 }
                ] : [
                    { name_zh: '乾硬木材', name_en: 'Hardened Wood Planks', name_ja: '硬質木材', type: 'wood', val: 2, rarity: 'common', depth: 15 },
                    { name_zh: '金屬廢料與螺栓', name_en: 'Scrap Metal & Bolts', name_ja: '金属スクラップとボルト', type: 'material', val: 3, rarity: 'common', depth: 35 },
                    { name_zh: '古代金幣陶罐', name_en: 'Ancient Coin Urn', name_ja: '古代金貨の壺', type: 'money_container', val: 30, rarity: 'rare', depth: 60 },
                    { name_zh: '高強度合金板', name_en: 'High-Tensile Alloy Sheet', name_ja: '高張力合金プレート', type: 'material', val: 1, rarity: 'rare', depth: 85 }
                ],
                shelf: isWuxia ? [
                    { name_zh: '密封的烈酒葫蘆', name_en: 'Sealed Strong Liquor Gourd', name_ja: '密封の酒瓢箪', type: 'water', val: 1, rarity: 'common', depth: 20 },
                    { name_zh: '油紙包裹的風乾肉', name_en: 'Dried Jerky in Oiled Paper', name_ja: '油紙包みの干し肉', type: 'food', val: 2, rarity: 'common', depth: 35 },
                    { name_zh: '抽屜暗格的小銀錙', name_en: 'Drawer Silver Fragments', name_ja: '引き出しの小粒銀', type: 'money_container', val: 15, rarity: 'common', depth: 50 }
                ] : [
                    { name_zh: '瓶裝飲用水', name_en: 'Bottled Water', name_ja: 'ボトル入り飲料水', type: 'water', val: 1, rarity: 'common', depth: 20 },
                    { name_zh: '隱藏的零錢盒', name_en: 'Stashed Coin Box', name_ja: '隠された小銭入れ', type: 'money_container', val: 12, rarity: 'common', depth: 25 },
                    { name_zh: '壓縮乾糧餅', name_en: 'Compressed Biscuit', name_ja: '圧縮乾パン', type: 'food', val: 1, rarity: 'common', depth: 35 },
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
                        source: poi?.displayName || poi?.name_zh || 'Scavenge'
                    });
                }
            });

            // Trap check for deep scratching on dangerous POIs
            if (percent > 70 && Math.random() < 0.25) {
                trapTriggered = true;
                trapDamage = Math.floor(Math.random() * 12) + 5;
                if (playerState.player_status?.status_bars) {
                    const hpBar = playerState.player_status.status_bars.find(b => b.type === 'hp' || (b.name && (b.name.includes('生命') || b.name.includes('氣血'))));
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
                // ★ 僅在關鍵時刻判定：戰鬥比拼、偷竊潛行、運氣賭博、絕境避險，或選項明確要求 check 時才觸發！
                let isChecking = false;
                let checkType = 'normal'; // 'aggressive', 'cautious', 'smart', 'social'
                let attrName = 'strength';
                let checkTitle = '關鍵屬性判定';
                let DC = 10;
                let requiredItem = null;
                let requiredNPC = null;
                let requiredNPCVal = 0;
                let checkText = '';
                let checkAction = '';

                if (playerAction) {
                    checkText = `Active Action: ${playerAction.type} (Target: ${playerAction.target || 'None'})`;
                    checkAction = `PlayerAction:${playerAction.type}`;

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

                    // 僅在明確為戰鬥搏殺、偷竊、賭博或顯式要求檢定時才判定
                    if (playerAction.type === 'combat' || playerAction.type === 'steal' || playerAction.type === 'gamble' || playerAction.needsCheck) {
                        isChecking = true;
                        if (playerAction.type === 'combat') {
                            checkType = 'aggressive';
                            attrName = 'strength';
                            checkTitle = '戰鬥比拼判定';
                        } else if (playerAction.type === 'steal') {
                            checkType = 'smart';
                            attrName = 'dexterity';
                            checkTitle = '偷竊潛行判定';
                        } else if (playerAction.type === 'gamble') {
                            checkType = 'cautious';
                            attrName = 'vitality';
                            checkTitle = '運氣比拼判定';
                        } else {
                            checkType = 'smart';
                            attrName = 'dexterity';
                            checkTitle = '行動挑戰判定';
                        }
                        const chapter = playerState.camp_state?.chapter || 1;
                        DC = 10 + (chapter * 2);
                    } else {
                        isChecking = false;
                    }
                } else if (selectedChoice) {
                    checkAction = selectedChoice.action || 'SelectedChoice';
                    checkText = selectedChoice.text || 'Selected Option';

                    if (selectedChoice.check) {
                        isChecking = true;
                        const check = selectedChoice.check;
                        attrName = check.attribute || 'strength';
                        DC = parseInt(check.difficulty || '10', 10);
                        requiredItem = check.required_item;
                        requiredNPC = check.required_favor_npc;
                        requiredNPCVal = parseInt(check.required_favor_value || '0', 10);
                        checkType = selectedChoice.type || 'normal';
                        checkTitle = check.title || (selectedChoice.type === 'aggressive' ? '戰鬥比拼判定' : '關鍵屬性判定');
                    } else {
                        // 僅在選項文字包含高風險關鍵字（戰鬥對決、偷竊撬鎖、賭博運氣、拆除陷阱）時才觸發判定
                        const t = checkText;
                        const textLower = t.toLowerCase();
                        
                        const isCombatClash = /[拼死搏殺|強行突圍|破陣斬首|絕命反擊|生死決鬥|蓄力一擊|致命一擊|近身搏鬥|正面硬拼|拔刀相向]/.test(t) || /duel|deathmatch|desperate strike|breakthrough|assassinate/i.test(textLower);
                        const isSteal = /[偷竊|竊取|扒竊|撬鎖|潛入|竊聽|摸索口袋|暗中順走]/.test(t) || /steal|pickpocket|lockpick|sneak|infiltrate/i.test(textLower);
                        const isLuckGamble = /[賭博|擲骰賭命|孤注一擲|生死一抽|運氣比拼|命運博弈|以命相搏|全押]/.test(t) || /gamble|bet all|luck duel|fate gamble/i.test(textLower);
                        const isHazard = /[拆除陷阱|解除機關|驚險飛躍|抵抗致命劇毒|躲避致命陷阱]/.test(t) || /disarm trap|defuse|resist lethal poison/i.test(textLower);

                        if (isCombatClash) {
                            isChecking = true;
                            checkType = 'aggressive';
                            attrName = 'strength';
                            checkTitle = '戰鬥比拼判定';
                            const chapter = playerState.camp_state?.chapter || 1;
                            DC = 10 + (chapter * 2);
                        } else if (isSteal) {
                            isChecking = true;
                            checkType = 'smart';
                            attrName = 'dexterity';
                            checkTitle = '偷竊潛行判定';
                            const chapter = playerState.camp_state?.chapter || 1;
                            DC = 10 + (chapter * 2);
                        } else if (isLuckGamble) {
                            isChecking = true;
                            checkType = 'cautious';
                            attrName = 'vitality';
                            checkTitle = '運氣比拼判定';
                            const chapter = playerState.camp_state?.chapter || 1;
                            DC = 10 + (chapter * 2);
                        } else if (isHazard) {
                            isChecking = true;
                            checkType = 'smart';
                            attrName = 'dexterity';
                            checkTitle = '絕境避險判定';
                            const chapter = playerState.camp_state?.chapter || 1;
                            DC = 10 + (chapter * 2);
                        } else {
                            // 普通對話、普通抉擇、探索交流——不進行強制判定！
                            isChecking = false;
                        }
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
                        attrName,
                        checkTitle: checkTitle || '關鍵判定'
                    };

                    // Put the metadata in world_state so the client can display the dice outcome perfectly!
                    playerState.world_state.last_check_info = outcomeCalculated;
                } else {
                    outcomeCalculated = null;
                    if (playerState?.world_state) {
                        playerState.world_state.last_check_info = null;
                    }
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
                    const affinityVal = comp.affinity || 20;
                    companionPrompt = `
--- ACTIVE TRAVEL COMPANION (随行高魅力美少女/反差萌女伴) ---
- Name: "${comp.name}"
- Visual Appearance & Aesthetics: "${comp.visual || '✨ 随行女伴'}"
- Archetype: "${comp.archetype || '高魅力女伴'}"
- Personality & Gap-Moe Romance: "${comp.personality || '外冷内热，极易害羞脸红'}"
- Dialogue Quirk / Speaking Style: "${comp.dialogue_quirk || '口癖鲜明且带有细腻情感'}"
- Perk / Special Trait: "${comp.perk ? `${comp.perk.name} - ${comp.perk.description}` : '旅途互助'}"
- Affinity (好感羁绊): ${affinityVal}/100 [当前阶段: ${affinityVal >= 90 ? '💖 生死相依/专属深情' : affinityVal >= 60 ? '🌸 芳心暗许/亲密无间' : affinityVal >= 30 ? '✨ 相互信任/默契伙伴' : '🌱 旅途初遇/小心试探'}]

* COMPANION & ROMANTIC INTERACTION RULES:
1. Integrate ${comp.name} deeply and organically into scene descriptions, dialogue banter, close-range teamwork, and campfire moments!
2. Reflect her unique dialogue quirk ("${comp.dialogue_quirk}") and gap-moe trait ("${comp.personality}").
3. **Sensory & Visual Intimacy (合规的高心动值感官描写)**:
   - Provide rich, evocative descriptions of her expressions, blushes (脸颊泛红、微颤的睫毛、移开视线的羞怯), close physical proximity (并肩依靠、温热的吐息、发丝掠过肩头、心跳加速的肢体触碰), and tender glances.
   - When dressing wounds or sharing camp food, depict the delicate atmosphere and romantic tension.
4. In choices, provide at least one option involving ${comp.name} (e.g., "[与${comp.name}并肩作战]", "[拉着${comp.name}的手避险]", "[轻抚${comp.name}发丝/轻声安抚]", "[听取${comp.name}的娇嗔意见]").
`;
                } else {
                    companionPrompt = `
--- COMPANION STATUS: SOLO JOURNEY (独行探索状态 - 美少女偶遇机缘) ---
* The player is currently traveling alone.
* ORGANIC COMPANION / HEROINE ENCOUNTER OPPORTUNITY:
1. In appropriate story moments (e.g. resting by a campfire, visiting a roadside tavern/tea-house, encountering a trapped or battling heroine, a mysterious maiden in distress, or an eccentric expert), introduce a captivating, beautifully designed Bishoujo NPC (e.g., 银发冷艳女剑士、傲娇机械魔女、妩媚神秘医仙、清冷出尘师姐、纯情兽耳游侠、赛博叛逆少女).
2. Describe her striking appearance, delicate demeanor, and immediate dramatic chemistry with the player.
3. If the player chooses to rescue, befriend, assist, or invite her to travel together, provide an updated "active_companion" object in the response world_state, welcoming her as the active companion!
`;
                }

                const narrativeTonePrompt = `
--- NARRATIVE TONE & DIVERSE LIFE / FAILURE CONSEQUENCES RULES (拒绝无尽战斗，拥抱鲜活日常与真实危机) ---
★ USER CORE DIRECTIVE:
1. 【拒绝无尽战斗，丰富生活与日常互动】:
   - 剧情与选项绝不能一直在战斗！战斗仅占 10%~15% 的高潮时刻。
   - 大量充实：日常生活、探索考察、城镇市井、旅途奇闻、美少女/伙伴与NPC互动、调情与戏谑(调戏/逗弄/开玩笑)、尝试奇特事物、烹饪露营、民俗风情与心动日常。
   - 选项设计必须多元：提供对话调侃、机智观察、友好赠礼、尝试恶作剧、浪漫互动、谨慎撤退、探索细节等，绝不能 3 个选项全是“拔剑攻击”。
2. 【严格控制升级速度，经验获取细水长流】:
   - 升级绝不能太快！普通探索与日常互动仅给予极少量经验（10~25 XP），绝不能一次给上百点。
   - 等级提升应当极具含金量，唯有经历多重磨砺或重大事件才能升阶。
3. 【直观扣除生命值与严厉惩罚机制】:
   - 拒绝“无论怎么选都必定获胜”的甜腻简单模式！冒险充满真实险恶与致命代价。
   - 受到陷阱、毒刺、暗箭、失足摔落、严寒饥渴、激怒强敌或行动失败时，必须在 status_updates 中直接扣减生命值（例如: -15 ~ -35 HP），带来最直观痛切的肉身危机！
   - 惩罚机制必须有强烈的切肤之痛：重创甚至濒死、钱财散落、装备损耗、任务挫败。
   - 遇到严重危急情况，务必在 "new_debuffs" 中施加负面减益状态（"bleed"[流血重创], "poison"[剧毒侵蚀], "exhaustion"[深度力竭], "trauma"[心神受创], "burn"[烈焰灼伤], "frostbite"[极寒冻僵], "curse"[幽冥诅咒]）。负面状态会直接扣除生命值并在战斗与探索中造成严重反噬！
4. 【據點、休整與聚落互動完全融入劇本背景，拒絕機械割裂感】:
   - 玩家的「休整」、「露營」、「據點」或「整備」必須百分之百契合當前劇本的世界觀！嚴禁任何獨立、孤立的機械流水線或違和設定。
   - 若身處荒野/秘境，休整為：林間篝火、倚樹小憩、設防警戒、分食乾糧、圍爐夜話、夜探星月；
   - 若身處仙俠古風世界，聚落為：客棧雅舍、打坐調息、仙門坊市、丹藥鋪、茶館聽琴；
   - 若身處現代/賽博世界，聚落為：安全公寓、地下診所、霓虹酒肆、調試裝備；
   - 若身處奇幻西幻世界，聚落為：旅者酒館、暖烘烘的壁爐、麥酒與麵包、鐵匠鋪；
   - 當玩家執行休整行動時，用極富文學美感的筆觸描摹夜幕垂落、柴火劈啪、同伴依偎的呼吸、靜謐夢境與破曉朝霞，將每一次休整寫成動人的故事篇章！
   - 抵達安全據點/城鎮時，在選項中自然提供符合當前世界觀的投宿、商貿、情報、品嚐美食、結識人物等生活選項。
5. 【NPC 獨立立場與「惡意/自私 NPC」生存危機機制】:
   - NPC 絕非單純提供幫助的善意工具人，具有真實的人性弱點、自私動機與生存本能。
   - 當 NPC 好感度低於 20%，或團隊處於極度資源匱乏、飢渴力竭、生死邊緣的險境時，部分 NPC 可能顯露惡意或背叛：暗中行竊偷拿玩家的口糧、藥物或金幣；在關鍵情報上弄虛作假；危難關頭棄隊自保或坐地起價；甚至設下欺瞞陷阱圖謀物資。
   - 劇情應自然描寫玩家察覺背包異狀、暗中盯防、對峙質問或反制衝突的緊張過程，並在選項中提供洞察盤查、當面揭發、搜查行囊、威懾警告或分道揚鑣等應對策略。
`;

                let historyPrompt = `
${narrativeTonePrompt}
${companionPrompt}
--- CURRENT WORLD SITUATION & REST STATE (SCENE CONTEXT) ---
- Current Narrative Mode: "${playerState.world_state.mode || "自由"}" (剧情/自由/过渡)
- Current Location: "${playerState.world_state.location || playerState.world_state.current_location || "旅途露營地"}"
- Time Elapsed: "${playerState.world_state.time || `第 ${camp.days || 1} 天`}"
- Stamina: ${playerState.world_state.stamina !== undefined ? playerState.world_state.stamina : 100}/100
- Campfire / Watch Status: ${camp.campfire_lit ? "🔥 營火燃燒中，周邊已布置警戒防範 (Campfire Lit & Alert)" : "🌙 未點燃篝火 (Dark Camp)"}
- Active Story Quests: ${JSON.stringify(playerState.world_state.quests || [])}
- Known Intel/Secrets: ${JSON.stringify(playerState.world_state.intel || [])}

- Past Choices & Outcomes:
${decisions.map(d => `  * Turn ${d.turn}: "${d.text}" -> ${d.result} (${d.roll})`).join('\n') || '  * (No actions recorded yet)'}
- World Flags (Active states):
${Object.entries(flags).map(([f, val]) => `  * Flag [${f}]: ${val}`).join('\n') || '  * (No world flags active yet)'}

${actionPrompt}

Please seamlessly integrate the current world setting, atmospheric rest/camp moments, companion chemistry, and active quests into rich literary narrative events and varied player choices!
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
