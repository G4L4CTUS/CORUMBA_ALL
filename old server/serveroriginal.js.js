const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const snmp = require('net-snmp');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));

const CONFIG_FILE = path.join(__dirname, 'printers-config.json');
let PRINTERS = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8') || '[]');

const OIDS = {
    toners: [
        '1.3.6.1.2.1.43.11.1.1.9.1.1', // K
        '1.3.6.1.2.1.43.11.1.1.9.1.2', // C
        '1.3.6.1.2.1.43.11.1.1.9.1.3', // M
        '1.3.6.1.2.1.43.11.1.1.9.1.4'  // Y
    ],
    paperCurrent: '1.3.6.1.2.1.43.8.2.1.10.1.1',
    paperUnitStatus: '1.3.6.1.2.1.43.8.2.1.11.1.1',
    counter: '1.3.6.1.2.1.43.10.2.1.4.1.1',
    status: '1.3.6.1.2.1.25.3.5.1.1.1', // 3=Ready, 4=Printing
    errorState: '1.3.6.1.2.1.25.3.5.1.2.1'
};

function parseToner(val) {
    const v = parseInt(val);
    if (v === -2 || v === -3) return { label: 'GENÉRICO', percent: 100, isAlert: false };
    if (v >= 0 && v <= 100) return { label: v + '%', percent: v, isAlert: v <= 10 };
    return { label: 'N/A', percent: 0, isAlert: false };
}

function detectErrors(status, errorByte, paperStatus) {
    const errors = [];
    const s = parseInt(status);
    const pStatus = parseInt(paperStatus);
    const byte = errorByte ? errorByte[0] : 0;
    
    // FILTRO DE ERRO FANTASMA: Se status for 3 (Ready) ou 4 (Printing), ignoramos sensores instáveis
    const isFunctional = (s === 3 || s === 4);

    if (byte & 64) errors.push("PAPEL ATOLADO");
    
    // Só reporta Porta Aberta ou Sem Papel se a impressora NÃO estiver funcional
    if (!isFunctional) {
        if (byte & 32) errors.push("PORTA ABERTA");
        if (byte & 128 || pStatus === 2) errors.push("SEM PAPEL");
    }
    return errors;
}

async function scan() {
    const results = await Promise.all(PRINTERS.map(printer => {
        return new Promise((resolve) => {
            const session = snmp.createSession(printer.ip, "public", { timeout: 2500, retries: 1 });
            const isColor = printer.model.includes('6270');
            const oidsToGet = isColor ? [...OIDS.toners] : [OIDS.toners[0]];
            oidsToGet.push(OIDS.paperCurrent, OIDS.paperUnitStatus, OIDS.counter, OIDS.status, OIDS.errorState);

            session.get(oidsToGet, (err, varbinds) => {
                if (err) {
                    resolve({ ...printer, status: 'offline', hasError: true, errorMessages: ['OFFLINE'] });
                } else {
                    const tCount = isColor ? 4 : 1;
                    const toners = [];
                    for(let i=0; i<tCount; i++) toners.push(parseToner(varbinds[i].value));
                    
                    const pCurrent = varbinds[tCount].value;
                    const pUnit = varbinds[tCount+1].value;
                    const status = varbinds[tCount+3].value;
                    const eByte = varbinds[tCount+4].value;

                    const errors = detectErrors(status, eByte, pUnit);

                    resolve({
                        ...printer,
                        status: 'online',
                        isColor,
                        toners,
                        paper: (parseInt(pUnit) === 0 || parseInt(pCurrent) > 0) ? 'OK' : 'VAZIO',
                        pageCount: parseInt(varbinds[tCount+2].value) || 0,
                        errorMessages: errors,
                        hasError: errors.length > 0
                    });
                }
                session.close();
            });
        });
    }));
    io.emit('printerUpdate', results);
}

setInterval(scan, 4000);

app.post('/api/printers', (req, res) => {
    const p = { id: Date.now(), ...req.body, unit: req.body.unit.toUpperCase() };
    PRINTERS.push(p);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(PRINTERS, null, 2));
    res.json(p);
});

app.delete('/api/printers/:id', (req, res) => {
    PRINTERS = PRINTERS.filter(p => p.id != req.params.id);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(PRINTERS, null, 2));
    res.json({ ok: true });
});

server.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));