

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const snmp       = require('net-snmp');
const axios      = require('axios');
const fs         = require('fs');
const path       = require('path');

// ── Inicialização ─────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 3000;

const basicAuth = require('express-basic-auth');
require('dotenv').config();
app.use(basicAuth({
    users: { [process.env.CORUMBA_USER]: process.env.CORUMBA_PASS },
    challenge: true,
    realm: 'Corumba soluções em T.I. - Area Restrita',
    unauthorizedResponse: 'Acesso negado. Credenciais incorretas.'
}));

app.use(express.json());
app.use(express.static('public'));

// ── Banco de Dados Impressoras ────────────────────────────────────────────────

const PRINTERS_FILE = path.join(__dirname, 'printers-config.json');
let PRINTERS = [];

try {
    PRINTERS = JSON.parse(fs.readFileSync(PRINTERS_FILE, 'utf8'));
} catch {
    fs.writeFileSync(PRINTERS_FILE, '[]');
};
const RECADOS_FILE = path.join(__dirname, `recados-config.json`);
let RECADOS=[];
try{
	RECADOS = JSON.parse(fs.readFileSync(RECADOS_FILE, `utf8`));
} catch{
	RECADOS=[];
	fs.writeFileSync(RECADOS_FILE, `[]`);
}

// ── OIDs SNMP ─────────────────────────────────────────────────────────────────

const OIDS = {
    toners: [
        '1.3.6.1.2.1.43.11.1.1.9.1.1', 
        '1.3.6.1.2.1.43.11.1.1.9.1.2', 
        '1.3.6.1.2.1.43.11.1.1.9.1.3', 
        '1.3.6.1.2.1.43.11.1.1.9.1.4'  
    ],
    paperCurrent:    '1.3.6.1.2.1.43.8.2.1.10.1.1',
    paperUnitStatus: '1.3.6.1.2.1.43.8.2.1.11.1.1',
    counter:         '1.3.6.1.2.1.43.10.2.1.4.1.1',
    status:          '1.3.6.1.2.1.25.3.5.1.1.1',
    errorState:      '1.3.6.1.2.1.25.3.5.1.2.1'
};
function parseToner(val) {
    const v = parseInt(val);
    if (v === -2 || v === -3) return { label: 'GENÉRICO', percent: 100, isAlert: false };
    if (v >= 0 && v <= 100) return { label: `${v}%`, percent: v, isAlert: v <= 10 };
    return { label: 'N/A', percent: 0, isAlert: false };
}

function detectErrors(status, errorByte, paperStatus) {
    const errors = [];
    const s = parseInt(status);
    const pStatus = parseInt(paperStatus);
    const byte = errorByte?.[0] ?? 0;
    const isFunctional = s === 3 || s === 4;

    if (byte & 64) errors.push('PAPEL ATOLADO');
    if (!isFunctional) {
        if (byte & 32) errors.push('PORTA ABERTA');
        if (byte & 128 || pStatus === 2) errors.push('SEM PAPEL');
    }
    return errors;
}

function bytesToMbps(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec <= 0) return 0;
    return parseFloat(((bytesPerSec * 8) / 1_000_000).toFixed(2));
}

// ── Mock de Computadores ──────────────────────────────────────────────────────

function getMockComputadores() {
    return [
        {
            agent_id: 1,
            hostname: "DESKTOP-RH",
            local_ips: '192.168.10.50',
            client_name: 'MATRIZ',
            site_name: 'Recpção',
            status: 'online',
            last_seen: new Date().toISOString(),
            operating_system: 'Windows 11 Pro',
            used_ram: 4096,
            total_ram: 8192,
            rx_speed: 1250000, 
            tx_speed: 500000
        },
        {
            agent_id: 2,
            hostname: 'FINANCEIRO-01',
            local_ips: '192.168.10.21',
            client_name: 'MATRIZ',
            site_name: 'Diretoria',
            status: 'offline',
            last_seen: "2024-03-15T10:00:00Z",
            operating_system: 'Windows 10 Pro',
            used_ram: 0,
            total_ram: 16384,
            rx_speed: 0,
            tx_speed: 0
        },
        {
            agent_id: 3,
            hostname: "SRV-DADOS",
            local_ips: "10.0.0.10",
            client_name: "FILIAL-SUL",
            site_name: "TI",
            status: 'online',
            last_seen: new Date().toISOString(),
            operating_system: "Windows Server 2022",
            used_ram: 12000,
            total_ram: 32768,
            rx_speed: 8000000,
            tx_speed: 2000000
        }
    ];
}

// ── Scanners ──────────────────────────────────────────────────────────────────

async function scanImpressoras() {
    if (!PRINTERS.length) return;
    const results = await Promise.all(PRINTERS.map(printer =>
        new Promise(resolve => {
            const session = snmp.createSession(printer.ip, 'public', { timeout: 2500, retries: 1 });
            const isColor = printer.model?.toUpperCase().includes('6270');
            const oidsToGet = isColor ? [...OIDS.toners] : [OIDS.toners[0]];
            oidsToGet.push(OIDS.paperCurrent, OIDS.paperUnitStatus, OIDS.counter, OIDS.status, OIDS.errorState);

            session.get(oidsToGet, (err, varbinds) => {
                session.close();
                if (err) {
                    return resolve({ 
                        ...printer, 
                        status: 'offline', 
                        hasError: true, 
                        errorMessages: ['OFFLINE'],
                        toners: [] // Evita erro de .map() no frontend
                    });
                }
                const tCount = isColor ? 4 : 1;
                const toners = Array.from({ length: tCount }, (_, i) => parseToner(varbinds[i].value));
                const errors = detectErrors(varbinds[tCount+3].value, varbinds[tCount+4].value, varbinds[tCount+1].value);

                resolve({
                    ...printer,
                    status: 'online',
                    isColor,
                    toners,
                    paper: (parseInt(varbinds[tCount+1].value) === 0 || parseInt(varbinds[tCount].value) > 0) ? 'OK' : 'VAZIO',
                    pageCount: parseInt(varbinds[tCount+2].value) || 0,
                    errorMessages: errors,
                    hasError: errors.length > 0
                });
            });
        })
    ));
    io.emit('printerUpdate', results);
}require('dotenv').config();
const TACTICAL_URL = (process.env.TACTICAL_URL);
const TACTICAL_API_KEY = process.env.TACTICAL_API_KEY;
async function scanComputadores() {
    try {
	console.log(`[TACTICAL] Consultando: ${TACTICAL_URL}`);
	
	
       const response = await axios.get(TACTICAL_URL,{
	   headers: {'X-API-KEY': TACTICAL_API_KEY,
	   'Content-Type': 'application/json'
	   },
	   timeout: 5000
	   });
		const data = response.data;
		console.log('[Tactical Campos]', Object.keys(data[0]));
		if (!Array.isArray(data)) {
			console.error(`[Tactical] A API não retornou um array:`, data);
			return;
		}
		console.log(`[Tactical Debug]`, JSON.stringify(data).slice(0, 500));		
        const Computadores = data.map(agent => ({
            id:          agent.agent_id,
            nome:        agent.hostname,
            ip:          (agent.local_ips || 'N/A').split(',')[0].trim(),
            cliente:     agent.client_name  || 'GERAL',
            site:        agent.site_name    || '',
            online:      agent.status === 'online',
            ultimoVisto: agent.last_seen,
            so:          agent.operating_system || 'N/A',
            cpu:         agent.cpu_model,
        }));
		ComputierOrdenados = Computadores.sort((a,b) =>{
			if (a.online === b.obline) return 0;
			return a.online? -1:1;
		});
			

        io.emit('computerUpdate', ComputierOrdenados);
    } catch (err) {
        console.error('[Tactical Error]', err.message);
    }
}

// ── Loops e Eventos ───────────────────────────────────────────────────────────

setInterval(scanImpressoras, 4000);
setInterval(scanComputadores, 15000);

scanComputadores();

io.on('connection', (socket) => {
    console.log('🔌 Novo cliente conectado');
    socket.emit('printerUpdate', PRINTERS); 
    socket.emit('recadosUpdate', RECADOS);   
    scanComputadores(); 
});

// ── Rotas API ─────────────────────────────────────────────────────────────────

app.post('/api/printers', (req, res) => {
    const { unit, name, ip, model } = req.body;
    if (!unit || !name || !ip || !model) return res.status(400).json({ erro: 'Campos obrigatórios' });
    const nova = { id: Date.now(), unit: unit.toUpperCase(), name, ip, model };
    PRINTERS.push(nova);
    fs.writeFileSync(PRINTERS_FILE, JSON.stringify(PRINTERS, null, 2));
    res.status(201).json(nova);
});

app.delete('/api/printers/:id', (req, res) => {
    PRINTERS = PRINTERS.filter(p => p.id != req.params.id);
    fs.writeFileSync(PRINTERS_FILE, JSON.stringify(PRINTERS, null, 2));
    res.json({ ok: true });
});

app.get('/api/status', (_req, res) => res.json({
    ok: true,
    impressoras: PRINTERS.length,
    uptime: Math.floor(process.uptime()) + 's'
}));
app.get(`/api/recados`, (req, res) => {
	res.json(RECADOS);
});
app.post(`/api/recados`, (req, res)=>{
	const{titulo, mensagem, urgente, autor, data} = req.body;
	if (!titulo || !mensagem) {
		return res.status(400).json({error: `Titulo e mensagem sã obrigatórios`});
		}
	const novoRecado = {
        id: Date.now(), 
        titulo,
        mensagem,
        urgente: urgente || false,
        autor: autor || 'Sistema',
        data: data || new Date().toISOString()
		};
		RECADOS.unshift(novoRecado);
		RECADOS.sort((a,b)=> {
			if(a.urgente === b.urgente) return 0;
			return a.urgente? -1 : 1;
		});
		if (RECADOS.length>50) RECADOS.pop();
		fs.writeFileSync(RECADOS_FILE, JSON.stringify(RECADOS, null, 2));
		io.emit(`recadosUpdate`, RECADOS);
		res.status(201).json(novoRecado);
	});
	app.delete(`/api/recados/:id`, (req, res)=>{
		RECADOS = RECADOS.filter(r => r.id != req.params.id);
		fs.writeFileSync(RECADOS_FILE, JSON.stringify(RECADOS, null, 2));
		io.emit(`recadosUpdate`, RECADOS);
		res.json({ok: true});
	});

// ── Início ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
    console.log(`\n🚀 Servidor pronto: http://localhost:${PORT}`);
    console.log(`📡 Tatical ativo para Computadores\n`);
	
});