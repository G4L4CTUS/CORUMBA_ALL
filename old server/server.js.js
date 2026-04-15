// ═══════════════════════════════════════════════════════════════════════════════
// FLEET MONITOR — server.js
// Servidor Node.js que monitora impressoras via SNMP e computadores via Tactical
// ═══════════════════════════════════════════════════════════════════════════════

// ── Importações ───────────────────────────────────────────────────────────────
// Cada require() carrega um módulo. Módulos nativos do Node não precisam de npm.

const express    = require('express');        // framework que cria rotas HTTP
const http       = require('http');           // módulo nativo — cria o servidor TCP
const { Server } = require('socket.io');      // comunicação em tempo real (servidor → browser)
const snmp       = require('net-snmp');       // fala com impressoras via protocolo SNMP
const axios      = require('axios');          // faz requisições HTTP para a API do Tactical
const fs         = require('fs');             // lê e escreve arquivos no disco
const path       = require('path');           // monta caminhos de arquivo com segurança

// ── Inicialização do servidor ─────────────────────────────────────────────────

const app    = express();                    // cria a aplicação Express
const server = http.createServer(app);       // cria o servidor HTTP usando Express como handler
                                             // separamos "app" do "server" porque o socket.io
                                             // precisa se anexar ao servidor HTTP, não ao Express
const io     = new Server(server);           // cria o socket.io em cima do servidor HTTP
const PORT   = process.env.PORT || 3000;     // porta: usa variável de ambiente ou 3000 como padrão

app.use(express.json());                     // middleware: permite ler JSON no body das requisições POST/PUT
app.use(express.static('public'));           // serve arquivos da pasta public/ (onde fica o index.html)
                                             // quando o browser acessa /, o Express devolve public/index.html

// ── Configuração do Tactical RMM ──────────────────────────────────────────────
// process.env lê variáveis de ambiente definidas no terminal antes de rodar o servidor
// Exemplo de uso antes de rodar:
//   export TACTICAL_URL=https://api.seudominio.com
//   export TACTICAL_API_KEY=suachave123
//   node server.js
// O || '' define string vazia como fallback — checamos isso antes de usar

const TACTICAL_URL     = process.env.TACTICAL_URL     || '';
const TACTICAL_API_KEY = process.env.TACTICAL_API_KEY || '';

// ── Banco de dados de impressoras (arquivo JSON) ───────────────────────────────
// Usamos um arquivo JSON simples como banco de dados
// Vantagem: zero configuração, funciona em qualquer máquina
// Desvantagem: não escala para milhares de registros (mas para impressoras, é suficiente)

const PRINTERS_FILE = path.join(__dirname, 'printers-config.json');
// __dirname = pasta onde este arquivo server.js está
// path.join monta o caminho completo de forma segura em qualquer sistema operacional

let PRINTERS = []; // array em memória — carregado do arquivo ao iniciar

try {
    PRINTERS = JSON.parse(fs.readFileSync(PRINTERS_FILE, 'utf8'));
    // readFileSync lê o arquivo inteiro de uma vez (síncrono — bloqueia até terminar)
    // JSON.parse converte a string JSON para array JavaScript
} catch {
    // se o arquivo não existir ou estiver corrompido, cria um arquivo vazio
    fs.writeFileSync(PRINTERS_FILE, '[]');
}

// ── OIDs SNMP ─────────────────────────────────────────────────────────────────
// SNMP é um protocolo de rede que permite consultar informações de dispositivos
// Cada OID (Object Identifier) é um endereço único que aponta para um dado específico
// dentro do dispositivo — como se fosse um índice em uma tabela gigante
// Os OIDs abaixo são padronizados para impressoras (RFC 3805)

const OIDS = {
    toners: [
        '1.3.6.1.2.1.43.11.1.1.9.1.1', // nível do toner Preto (K de Key/Black)
        '1.3.6.1.2.1.43.11.1.1.9.1.2', // nível do toner Ciano (C)
        '1.3.6.1.2.1.43.11.1.1.9.1.3', // nível do toner Magenta (M)
        '1.3.6.1.2.1.43.11.1.1.9.1.4'  // nível do toner Amarelo (Y)
    ],
    paperCurrent:    '1.3.6.1.2.1.43.8.2.1.10.1.1',  // quantidade de papel na bandeja
    paperUnitStatus: '1.3.6.1.2.1.43.8.2.1.11.1.1',  // status da bandeja (0=ok, 2=vazia)
    counter:         '1.3.6.1.2.1.43.10.2.1.4.1.1',  // contador total de páginas impressas
    status:          '1.3.6.1.2.1.25.3.5.1.1.1',      // status geral (3=pronta, 4=imprimindo)
    errorState:      '1.3.6.1.2.1.25.3.5.1.2.1'       // byte de erros (cada bit = um tipo de erro)
};

// ── parseToner ────────────────────────────────────────────────────────────────
// Interpreta o valor bruto do OID de toner e devolve um objeto legível
// Os valores chegam como strings do SNMP — precisamos converter e interpretar

function parseToner(val) {
    const v = parseInt(val); // converte string para número inteiro

    if (v === -2 || v === -3) return { label: 'GENÉRICO', percent: 100, isAlert: false };
    // -2 e -3 são códigos especiais que indicam toner genérico sem chip de medição
    // tratamos como 100% para não gerar alerta falso

    if (v >= 0 && v <= 100) return { label: `${v}%`, percent: v, isAlert: v <= 10 };
    // valor normal: retorna porcentagem e marca alerta se <= 10%
    // isAlert: true faz o número piscar vermelho no frontend

    return { label: 'N/A', percent: 0, isAlert: false };
    // qualquer outro valor é desconhecido
}

// ── detectErrors ──────────────────────────────────────────────────────────────
// Analisa os bytes de status da impressora e retorna os erros ativos
// O errorByte é um número onde cada bit representa um tipo de erro diferente
// Usamos operador bitwise AND (&) para verificar bits individuais

function detectErrors(status, errorByte, paperStatus) {
    const errors       = [];
    const s            = parseInt(status);      // status geral (3=pronta, 4=imprimindo)
    const pStatus      = parseInt(paperStatus); // status da bandeja
    const byte         = errorByte?.[0] ?? 0;   // pega o primeiro byte do buffer, ou 0 se não existir
                                                 // ?. é optional chaining: se errorByte for null/undefined, retorna undefined
                                                 // ?? é nullish coalescing: se o resultado for null/undefined, usa 0
    const isFunctional = s === 3 || s === 4;
    // se a impressora está funcionando normalmente (pronta ou imprimindo),
    // alguns sensores ficam instáveis e geram falsos positivos
    // então ignoramos porta aberta e sem papel quando está funcionando

    if (byte & 64)  errors.push('PAPEL ATOLADO');
    // byte & 64 = operação AND bit a bit
    // 64 em binário = 01000000
    // se o bit 6 estiver ligado no byte de erro → há atolamento
    // papel atolado é reportado SEMPRE, mesmo funcionando

    if (!isFunctional) {
        if (byte & 32) errors.push('PORTA ABERTA');
        // 32 em binário = 00100000 → bit 5 = porta aberta

        if (byte & 128 || pStatus === 2) errors.push('SEM PAPEL');
        // 128 em binário = 10000000 → bit 7 = sem papel
        // pStatus === 2 é uma segunda forma de detectar sem papel
    }

    return errors; // array vazio = sem erros
}

// ── scanImpressoras ───────────────────────────────────────────────────────────
// Consulta todas as impressoras cadastradas via SNMP e emite os resultados
// É chamada a cada 4 segundos pelo setInterval

async function scanImpressoras() {
    if (!PRINTERS.length) return; // sem impressoras cadastradas, não faz nada

    // Promise.all executa todas as consultas em paralelo (ao mesmo tempo)
    // sem isso, seriam sequenciais — se tiver 10 impressoras com 2.5s de timeout cada, levaria 25 segundos
    // com Promise.all, todas rodam juntas e o resultado fica pronto em ~2.5 segundos
    const results = await Promise.all(PRINTERS.map(printer =>
        new Promise(resolve => {
            // cria uma sessão SNMP com a impressora
            // "public" é a community string padrão (senha da rede SNMP)
            const session = snmp.createSession(printer.ip, 'public', {
                timeout: 2500, // desiste se não responder em 2.5 segundos
                retries: 1     // tenta mais uma vez antes de desistir
            });

            // detecta se é colorida pelo modelo
            // se o modelo contiver '6270', é colorida (4 toners)
            // senão, é monocromática (1 toner)
            const isColor = printer.model?.toUpperCase().includes('6270');
            // ?. é optional chaining: se printer.model for undefined, retorna undefined em vez de quebrar

            // monta a lista de OIDs que vamos consultar
            // colorida: 4 toners | monocromática: só o toner preto
            const oidsToGet = isColor ? [...OIDS.toners] : [OIDS.toners[0]];
            // [...OIDS.toners] cria uma cópia do array (spread operator)
            // sem o spread, adicionarmos os outros OIDs modificaria o array original

            // adiciona os OIDs comuns (papel, contador, status, erros)
            oidsToGet.push(OIDS.paperCurrent, OIDS.paperUnitStatus, OIDS.counter, OIDS.status, OIDS.errorState);

            // faz a consulta SNMP de fato — busca todos os OIDs de uma vez
            session.get(oidsToGet, (err, varbinds) => {
                session.close(); // fecha a sessão imediatamente para liberar recursos de rede
                // fechamos antes de processar para não deixar conexões abertas em caso de erro

                if (err) {
                    // timeout ou impressora inacessível → retorna como offline
                    // usamos resolve() mesmo no erro (nunca reject) para não quebrar o Promise.all
                    return resolve({ ...printer, status: 'offline', hasError: true, errorMessages: ['OFFLINE'] });
                }

                // varbinds é um array de respostas na mesma ordem dos OIDs pedidos
                // varbinds[0] = primeiro toner, varbinds[1] = segundo toner, etc.
                const tCount = isColor ? 4 : 1; // quantos toners existem

                // Array.from cria um array com "tCount" elementos
                // o segundo argumento é uma função que roda para cada posição
                // (_, i) → _ é o valor (ignorado), i é o índice
                const toners = Array.from({ length: tCount }, (_, i) => parseToner(varbinds[i].value));

                // os outros valores vêm depois dos toners, por isso usamos tCount como offset
                // tCount+0 = paperCurrent, tCount+1 = paperUnitStatus, tCount+2 = counter, etc.
                const errors = detectErrors(
                    varbinds[tCount+3].value, // status geral
                    varbinds[tCount+4].value, // byte de erros
                    varbinds[tCount+1].value  // status da bandeja
                );

                resolve({
                    ...printer,   // copia os campos originais (id, name, ip, model, unit)
                    status:  'online',
                    isColor,
                    toners,
                    paper:     (parseInt(varbinds[tCount+1].value) === 0 || parseInt(varbinds[tCount].value) > 0) ? 'OK' : 'VAZIO',
                    pageCount: parseInt(varbinds[tCount+2].value) || 0,
                    errorMessages: errors,
                    hasError:  errors.length > 0
                });
            });
        })
    ));

    // emite os dados para TODOS os browsers conectados via socket.io
    // o frontend está ouvindo esse evento e redesenha os cards automaticamente
    io.emit('printerUpdate', results);
}

// ── bytesToMbps ───────────────────────────────────────────────────────────────
// Converte bytes por segundo (como o Tactical reporta) para Megabits por segundo
// Fórmula: bytes × 8 ÷ 1.000.000
// bytes → bits: multiplica por 8 (1 byte = 8 bits)
// bits → megabits: divide por 1.000.000

function bytesToMbps(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec <= 0) return 0;
    return parseFloat(((bytesPerSec * 8) / 1_000_000).toFixed(2));
    // 1_000_000 é igual a 1000000 — o underscore é só para legibilidade (JS suporta isso)
    // toFixed(2) arredonda para 2 casas decimais e retorna string: "12.50"
    // parseFloat converte de volta para número: 12.5
}

// ── scanComputadores ──────────────────────────────────────────────────────────
// Consulta todos os agentes do Tactical RMM via API REST e emite os resultados
// É chamada a cada 15 segundos pelo setInterval

async function scanComputadores() {
    // verifica se as credenciais foram configuradas antes de tentar conectar
    if (!TACTICAL_URL || !TACTICAL_API_KEY) {
        io.emit('computerUpdate', {
            erro: true,
            mensagem: 'Tactical RMM não configurado. Defina TACTICAL_URL e TACTICAL_API_KEY.'
        });
        return; // sai da função sem tentar conectar
    }

    try {
        // GET /agents/ — endpoint que retorna todos os agentes cadastrados no Tactical
        // axios desestrutura o resultado: { data } pega só o campo data da resposta
        // sem desestruturação seria: const response = await axios.get(...); const data = response.data;
        const { data } = await axios.get(`${TACTICAL_URL}/agents/`, {
            headers: {
                'X-API-KEY': TACTICAL_API_KEY
                // o Tactical autentica via header customizado X-API-KEY
                // diferente de OAuth ou Bearer token — é mais simples
            },
            timeout: 8000 // 8 segundos para o Tactical responder, depois lança erro
        });

        // data é um array com todos os agentes — cada objeto tem dezenas de campos
        // .map() transforma cada agente em um objeto menor com só o que precisamos
        const computadores = data.map(agent => ({
            id:          agent.agent_id,
            // agent_id é o identificador único interno do Tactical

            nome:        agent.hostname,
            // nome do computador na rede Windows (ex: "DESKTOP-JOAO")

            ip:          (agent.local_ips || agent.public_ip || 'N/A').split(',')[0].trim(),
            // local_ips pode conter vários IPs separados por vírgula: "192.168.1.10, 192.168.1.11"
            // .split(',') transforma em array: ["192.168.1.10", " 192.168.1.11"]
            // [0] pega só o primeiro
            // .trim() remove espaços extras

            cliente:     agent.client_name  || 'GERAL',
            // client_name = nome do cliente no Tactical (equivalente ao "unit" das impressoras)
            // || 'GERAL' garante que nunca seja vazio

            site:        agent.site_name    || '',
            // site = subdivisão dentro do cliente (ex: "Filial Centro")

            online:      agent.status === 'online',
            // o Tactical devolve status como string "online" ou "offline"
            // convertemos para booleano (true/false) para facilitar o uso no frontend

            ultimoVisto: agent.last_seen,
            // string ISO 8601: "2024-01-15T10:30:00.000Z"
            // o frontend converte para formato legível com new Date().toLocaleString()

            so:          agent.operating_system || 'N/A',
            // ex: "Windows 10 Pro, 64 bit (build 19045.3693)"

            usoRam:      agent.used_ram   || 0,
            // RAM usada em MB — o || 0 garante que nunca seja null/undefined

            totalRam:    agent.total_ram  || 0,
            // RAM total em MB — porcentagem = (usoRam / totalRam) * 100

            rxMbps:      bytesToMbps(agent.rx_speed),
            // rx = receive = download — o Tactical reporta em bytes/s, convertemos para Mbps

            txMbps:      bytesToMbps(agent.tx_speed),
            // tx = transmit = upload
        }));

        // emite para todos os browsers — igual ao printerUpdate
        io.emit('computerUpdate', computadores);

    } catch (err) {
        console.error('[Tactical]', err.message);

        // err.response existe quando o servidor respondeu com erro HTTP (4xx, 5xx)
        // err.response?.status usa optional chaining: se err.response for undefined, retorna undefined
        // isso evita o erro "Cannot read property 'status' of undefined"
        io.emit('computerUpdate', {
            erro: true,
            mensagem: err.response?.status === 401
                ? 'Chave de API inválida ou sem permissão.'       // erro de autenticação
                : 'Não foi possível conectar ao Tactical RMM.'    // erro de rede/timeout
        });
    }
}

// ── Intervalos de scan ────────────────────────────────────────────────────────

setInterval(scanImpressoras,   4000);  // impressoras: a cada 4 segundos
setInterval(scanComputadores, 15000);  // computadores: a cada 15 segundos
                                       // computadores mudam menos — 15s equilibra atualização e carga

scanComputadores();
// executa imediatamente ao iniciar o servidor
// sem isso, o browser ficaria em branco pelos primeiros 15 segundos

// ── Evento de nova conexão socket.io ─────────────────────────────────────────

io.on('connection', () => scanImpressoras());
// toda vez que um browser se conecta, dispara um scan imediato de impressoras
// assim o usuário vê os dados na hora, sem esperar o próximo intervalo de 4s

// ── Rotas da API REST ─────────────────────────────────────────────────────────

// POST /api/printers — adiciona uma nova impressora
app.post('/api/printers', (req, res) => {
    const { unit, name, ip, model } = req.body;
    // desestruturação: extrai os campos do body de uma vez
    // equivale a: const unit = req.body.unit; const name = req.body.name; etc.

    // validação: todos os campos são obrigatórios
    if (!unit || !name || !ip || !model) {
        return res.status(400).json({ erro: 'Campos obrigatórios: unit, name, ip, model' });
        // 400 = Bad Request — o cliente enviou dados inválidos
        // o return impede que o código continue após responder
    }

    const nova = { id: Date.now(), unit: unit.toUpperCase(), name, ip, model };
    // Date.now() retorna o timestamp atual em ms — funciona como ID único simples
    // unit.toUpperCase() padroniza para maiúsculas (ex: "cliente a" → "CLIENTE A")

    PRINTERS.push(nova);
    fs.writeFileSync(PRINTERS_FILE, JSON.stringify(PRINTERS, null, 2));
    // null, 2 = formata o JSON com 2 espaços de indentação (mais legível no arquivo)
    // writeFileSync é síncrono — garante que o arquivo foi salvo antes de responder

    res.status(201).json(nova);
    // 201 = Created — resposta padrão para criação bem-sucedida
    // devolve a impressora criada (com o ID gerado) para o frontend
});

// DELETE /api/printers/:id — remove uma impressora pelo ID
app.delete('/api/printers/:id', (req, res) => {
    const antes = PRINTERS.length;

    PRINTERS = PRINTERS.filter(p => p.id != req.params.id);
    // != (não ===) porque req.params.id é sempre string (vem da URL)
    // e p.id pode ser número (foi salvo como Date.now() que retorna número)
    // != faz conversão de tipo: '123' != 123 → false (são iguais)
    // === não faria: '123' !== 123 → true (seriam diferentes)

    if (PRINTERS.length === antes) {
        return res.status(404).json({ erro: 'Impressora não encontrada' });
        // se o tamanho do array não mudou, o ID não existia
    }

    fs.writeFileSync(PRINTERS_FILE, JSON.stringify(PRINTERS, null, 2));
    res.json({ ok: true });
});

// GET /api/status — health check (verifica se o servidor está rodando)
app.get('/api/status', (_req, res) => res.json({
    ok:          true,
    impressoras: PRINTERS.length,
    tactical:    TACTICAL_URL ? 'configurado' : 'não configurado',
    uptime:      Math.floor(process.uptime()) + 's'
    // process.uptime() retorna quantos segundos o servidor está rodando
    // Math.floor remove os decimais
}));

// ── Inicia o servidor ─────────────────────────────────────────────────────────

server.listen(PORT, () => {
    // server.listen (não app.listen) porque o socket.io está anexado ao "server"
    console.log(`\n🚀  http://localhost:${PORT}`);
    console.log(`🖨️   Impressoras: ${PRINTERS.length}`);
    console.log(`📡  Tactical: ${TACTICAL_URL || 'não configurado'}\n`);
});