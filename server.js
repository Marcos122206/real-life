const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, Date.now() + '-' + Math.random().toString(36).slice(2,8) + ext);
    }
});
const upload = multer({ 
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if(file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Apenas imagens!'), false);
    }
});

function lerDados() {
    if (!fs.existsSync(DB_FILE)) {
        return { posts: [], usuarios: {}, contas: {}, perfis: {}, seguindo: {} };
    }
    try {
        const dados = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        return {
            contas: dados.contas || {},
            usuarios: dados.usuarios || {},
            perfis: dados.perfis || {},
            posts: dados.posts || [],
            seguindo: dados.seguindo || {}
        };
    } catch (e) {
        return { posts: [], usuarios: {}, contas: {}, perfis: {}, seguindo: {} };
    }
}

function salvarDados(dados) {
    fs.writeFileSync(DB_FILE, JSON.stringify(dados, null, 2));
}

// --- ROTAS DE AUTH ---
app.post('/api/registro', async (req, res) => {
    try {
        const { usuario, senha } = req.body;
        if (!usuario || !senha) return res.status(400).json({ erro: 'Preencha todos os campos.' });
        if (usuario.length < 3) return res.status(400).json({ erro: 'Usuário muito curto.' });
        const db = lerDados();
        if (db.contas[usuario]) return res.status(400).json({ erro: 'Usuário já existe.' });
        
        db.contas[usuario] = await bcrypt.hash(senha, 10);
        db.usuarios[usuario] = 0;
        db.perfis[usuario] = { bio: 'Vivendo no Real Life 🌍', corTema: '#6366f1', avatar: usuario.slice(0,2).toUpperCase() };
        db.seguindo[usuario] = [];
        salvarDados(db);
        res.json({ mensagem: 'Conta criada com sucesso!' });
    } catch (e) {
        res.status(500).json({ erro: 'Erro interno no servidor.' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { usuario, senha } = req.body;
        const db = lerDados();
        if (!db.contas[usuario]) return res.status(400).json({ erro: 'Usuário ou senha inválidos.' });
        const senhaValida = await bcrypt.compare(senha, db.contas[usuario]);
        if (!senhaValida) return res.status(400).json({ erro: 'Usuário ou senha inválidos.' });
        res.json({ mensagem: 'Login bem-sucedido!', usuario });
    } catch (e) {
        res.status(500).json({ erro: 'Erro interno no servidor.' });
    }
});

// --- POSTS ---
app.post('/posts', upload.single('imagem'), (req, res) => {
    const { usuario, legenda } = req.body;
    if (!req.file) return res.status(400).json({ erro: 'Nenhuma imagem enviada.' });

    const db = lerDados();
    const novoPost = {
        id: Date.now(),
        usuario: usuario || 'anonimo',
        imagem: `/uploads/${req.file.filename}`,
        legenda: legenda || '',
        curtidas: [],
        comentarios: [],
        data: new Date().toLocaleDateString('pt-BR'),
        timestamp: Date.now()
    };

    db.posts.push(novoPost);
    db.usuarios[usuario] = (db.usuarios[usuario] || 0) + 10;
    salvarDados(db);

    io.emit('novo-post', novoPost);
    io.emit('atualizar-posts');
    res.json({ mensagem: 'Postado!', post: novoPost });
});

app.post('/posts/:id/curtir', (req, res) => {
    const { usuario } = req.body;
    const postId = Number(req.params.id);
    const db = lerDados();
    const post = db.posts.find(p => p.id === postId);
    if (!post) return res.status(404).json({ erro: 'Post não encontrado.' });

    const index = post.curtidas.indexOf(usuario);
    if (index > -1) post.curtidas.splice(index, 1);
    else post.curtidas.push(usuario);

    salvarDados(db);
    io.emit('atualizar-posts');
    res.json({ curtidas: post.curtidas });
});

app.post('/posts/:id/comentar', (req, res) => {
    const { usuario, texto } = req.body;
    const postId = Number(req.params.id);
    if (!texto?.trim()) return res.status(400).json({ erro: 'Comentário vazio.' });

    const db = lerDados();
    const post = db.posts.find(p => p.id === postId);
    if (!post) return res.status(404).json({ erro: 'Post não encontrado.' });

    const comentario = { 
        usuario, 
        texto: texto.trim(), 
        data: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        id: Date.now()
    };
    post.comentarios.push(comentario);
    salvarDados(db);
    io.emit('atualizar-posts');
    res.json({ comentarios: post.comentarios });
});

// --- DADOS GERAIS ---
app.get('/dados', (req, res) => {
    const db = lerDados();
    const ranking = Object.entries(db.usuarios || {})
        .map(([usuario, pontos]) => ({ usuario, pontos }))
        .sort((a, b) => b.pontos - a.pontos);

    res.json({
        posts: [...db.posts].reverse(),
        ranking,
        perfis: db.perfis,
        seguindo: db.seguindo
    });
});

app.post('/api/perfil', (req, res) => {
    const { usuario, bio, corTema } = req.body;
    const db = lerDados();
    if (!db.perfis[usuario]) db.perfis[usuario] = {};
    if (bio !== undefined) db.perfis[usuario].bio = bio;
    if (corTema) db.perfis[usuario].corTema = corTema;
    salvarDados(db);
    res.json({ mensagem: 'Perfil atualizado!' });
});

app.post('/api/seguir', (req, res) => {
    const { usuario, alvo } = req.body;
    const db = lerDados();
    if (!db.seguindo[usuario]) db.seguindo[usuario] = [];
    
    const index = db.seguindo[usuario].indexOf(alvo);
    const seguindoAgora = index === -1;
    if (index > -1) db.seguindo[usuario].splice(index, 1);
    else db.seguindo[usuario].push(alvo);
    
    salvarDados(db);
    res.json({ seguindo: db.seguindo[usuario], seguindoAgora });
});

// Serve o front novo por padrão
app.get('/', (req, res) => {
    const finalPath = path.join(__dirname, 'real-life-final.html');
    const oldPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(finalPath)) return res.sendFile(finalPath);
    if (fs.existsSync(oldPath)) return res.sendFile(oldPath);
    res.send('Coloque o real-life-final.html na mesma pasta');
});

io.on('connection', (socket) => {
    console.log('Usuário conectado:', socket.id);
    socket.on('enviar-mensagem', (data) => io.emit('receber-mensagem', data));
    socket.on('disconnect', () => console.log('Desconectado:', socket.id));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Real Life rodando em http://localhost:${PORT}`);
});