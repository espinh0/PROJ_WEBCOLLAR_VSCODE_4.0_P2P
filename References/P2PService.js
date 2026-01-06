import { RTCPeerConnection, RTCIceCandidate, RTCSessionDescription } from 'react-native-webrtc';

// Polyfill para WebRTC no React Native para o PeerJS funcionar
global.RTCPeerConnection = RTCPeerConnection;
global.RTCIceCandidate = RTCIceCandidate;
global.RTCSessionDescription = RTCSessionDescription;

// POLYFILL CRÍTICO: Deve ser executado ANTES de importar PeerJS
// Hermes (engine JS do React Native) não implementa URLSearchParams.set
if (typeof URLSearchParams !== 'undefined') {
  if (!URLSearchParams.prototype.set) {
    URLSearchParams.prototype.set = function(name, value) {
      const entries = [];
      this.forEach((v, k) => {
        if (k !== name) entries.push([k, v]);
      });
      entries.push([name, String(value)]);
      const keysToDelete = [];
      this.forEach((v, k) => keysToDelete.push(k));
      keysToDelete.forEach(k => this.delete(k));
      entries.forEach(([k, v]) => this.append(k, v));
    };
    console.log('✅ URLSearchParams.set polyfill aplicado!');
  }
  if (!URLSearchParams.prototype.get) {
    URLSearchParams.prototype.get = function(name) {
      let result = null;
      this.forEach((v, k) => { if (k === name && result === null) result = v; });
      return result;
    };
    console.log('✅ URLSearchParams.get polyfill aplicado!');
  }
  if (!URLSearchParams.prototype.has) {
    URLSearchParams.prototype.has = function(name) {
      let found = false;
      this.forEach((v, k) => { if (k === name) found = true; });
      return found;
    };
    console.log('✅ URLSearchParams.has polyfill aplicado!');
  }
} else {
  console.error('❌ URLSearchParams não existe! Criando do zero...');
  // Implementação básica de URLSearchParams
  global.URLSearchParams = class URLSearchParams {
    constructor(init = '') {
      this._entries = [];
      if (typeof init === 'string') {
        init.replace(/^\?/, '').split('&').forEach(pair => {
          const [key, value] = pair.split('=').map(decodeURIComponent);
          if (key) this._entries.push([key, value || '']);
        });
      }
    }
    append(name, value) { this._entries.push([name, String(value)]); }
    delete(name) { this._entries = this._entries.filter(([k]) => k !== name); }
    get(name) { const e = this._entries.find(([k]) => k === name); return e ? e[1] : null; }
    has(name) { return this._entries.some(([k]) => k === name); }
    set(name, value) { this.delete(name); this.append(name, value); }
    forEach(callback) { this._entries.forEach(([k, v]) => callback(v, k, this)); }
    toString() { return this._entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'); }
  };
  console.log('✅ URLSearchParams criado do zero!');
}

// Agora importamos PeerJS DEPOIS dos polyfills
const { Peer } = require('peerjs');

class P2PService {
  constructor() {
    this.peer = null;
    this.myId = null;
    this.connections = new Map(); // Use a Map to store connections by peerId
    this.nickname = 'Anônimo'; // Default nickname
    this.onMessageReceived = null;
    this.onConnectionOpened = null;
    this.onDisconnected = null;
    this.onError = null; // Callback para erros
    this.onConnectionListChanged = null; // Callback for connection list changes
    this.onIdReceivedCallback = null; // To store the ID callback for renewals
  }

  setNickname(nickname) {
    this.nickname = nickname || 'Anônimo';
    // Inform other peers about the nickname change
    this.sendMessage({ type: 'NICKNAME_UPDATE', payload: this.nickname });
  }

  initialize(onIdReceived) {
    this.onIdReceivedCallback = onIdReceived; // Store for renewals

    if (this.peer) {
      this.peer.destroy();
    }
    try {
      // Cria um novo Peer (usuário)
      // Configuração explícita para evitar problemas de conexão
      this.peer = new Peer(undefined, { 
        debug: 3,
        secure: true, // Força HTTPS
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
          ]
        }
      });

      this.peer.on('open', (id) => {
        console.log('Meu ID P2P é:', id);
        this.myId = id;
        if (this.onIdReceivedCallback) this.onIdReceivedCallback(id);
      });

      this.peer.on('connection', (conn) => {
        console.log('Alguém conectou em mim!', conn.peer);
        this.setupConnection(conn);
      });

      this.peer.on('error', (err) => {
        console.error('Erro no PeerJS:', err);
        console.error('Tipo do erro:', err.type);
        console.error('Mensagem do erro:', err.message);
        console.error('Erro completo:', JSON.stringify(err, null, 2));
        if (this.onError) this.onError(err.type + ': ' + (err.message || 'Erro de conexão com o servidor'));
      });

    } catch (e) {
      console.error("Erro fatal ao inicializar Peer:", e);
      if (this.onError) this.onError("Erro Fatal: " + e.message);
    }
  }

  connectToPeer(remotePeerId) {
    if (!this.peer) {
      if (this.onError) this.onError("Peer não inicializado.");
      return;
    }
    console.log('Tentando conectar em:', remotePeerId);
    try {
      const conn = this.peer.connect(remotePeerId, {
        metadata: { nickname: this.nickname }, // Envia o nickname ao conectar
      });
      this.setupConnection(conn);
    } catch (e) {
      console.error("Erro ao conectar:", e);
      if (this.onError) this.onError("Erro ao conectar: " + e.message);
    }
  }

  setupConnection(conn) {
    // Inicializa metadata se não existir
    if (!conn.metadata) {
      conn.metadata = {};
    }
    // Armazena o nickname do peer remoto (pode vir vazio inicialmente)
    conn.metadata.nickname = conn.metadata.nickname || 'Anônimo';

    conn.on('open', () => {
      console.log('Conexão aberta com:', conn.peer, 'Nickname:', conn.metadata.nickname);
      this.connections.set(conn.peer, conn);
      if (this.onConnectionOpened) this.onConnectionOpened(conn.peer);
      if (this.onConnectionListChanged) this.onConnectionListChanged(this.getConnections());

      // Envia nosso nickname imediatamente após abrir a conexão
      conn.send({ type: 'NICKNAME_UPDATE', payload: this.nickname });
    });

    conn.on('data', (data) => {
      console.log('Dados recebidos:', data);

      // Handle nickname updates
      if (data.type === 'NICKNAME_UPDATE') {
        console.log('Atualizando nickname de', conn.peer, 'para:', data.payload);
        // Atualiza diretamente no conn também
        conn.metadata.nickname = data.payload || 'Anônimo';
        
        // Atualiza na lista de conexões
        const connection = this.connections.get(conn.peer);
        if (connection) {
          connection.metadata.nickname = data.payload || 'Anônimo';
          this.connections.set(conn.peer, connection);
        }
        if (this.onConnectionListChanged) this.onConnectionListChanged(this.getConnections());
        return; // Don't process as a regular message
      }

      // Handle peer leaving notification
      if (data.type === 'PEER_LEAVING') {
        console.log('Peer está saindo:', conn.peer, 'Nickname:', data.payload?.nickname);
        this.connections.delete(conn.peer);
        if (this.onDisconnected) this.onDisconnected(conn.peer);
        if (this.onConnectionListChanged) this.onConnectionListChanged(this.getConnections());
        return;
      }

      if (this.onMessageReceived) {
        const senderNickname = conn.metadata.nickname || 'Anônimo';
        this.onMessageReceived(data, conn.peer, senderNickname);
      }
    });

    conn.on('close', () => {
      console.log('Conexão fechada com:', conn.peer);
      this.connections.delete(conn.peer);
      if (this.onDisconnected) this.onDisconnected(conn.peer);
      if (this.onConnectionListChanged) this.onConnectionListChanged(this.getConnections());
    });

    conn.on('error', (err) => {
      console.error('Erro na conexão:', err);
      if (this.onError) this.onError("Erro Conexão: " + err.message);
    });
  }

  sendMessage(message) {
    this.connections.forEach(conn => {
      if (conn.open) {
        conn.send(message);
      }
    });
  }

  // Notifica todos os peers que estamos saindo e fecha as conexões
  disconnect() {
    console.log('Desconectando de todos os peers...');
    
    // Envia mensagem de saída para todos os peers conectados
    this.connections.forEach(conn => {
      if (conn.open) {
        try {
          conn.send({ type: 'PEER_LEAVING', payload: { nickname: this.nickname } });
          // Fecha a conexão após enviar a mensagem
          setTimeout(() => conn.close(), 100);
        } catch (e) {
          console.error('Erro ao enviar mensagem de saída:', e);
        }
      }
    });
    
    // Limpa as conexões
    this.connections.clear();
    if (this.onConnectionListChanged) this.onConnectionListChanged([]);
  }

  getConnections() {
    return Array.from(this.connections.values()).map(conn => {
      const isBot = (conn.metadata.nickname && conn.metadata.nickname.toLowerCase().includes('bot')) ||
                    (conn.metadata.nickname && conn.metadata.nickname.toLowerCase().includes('flashscore'));
      return {
        peerId: conn.peer,
        nickname: conn.metadata.nickname,
        isBot: isBot,
      };
    });
  }

  renewId() {
    console.log('Renovando o ID...');
    this.initialize(this.onIdReceivedCallback);
  }

  destroy() {
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
    this.connections.clear();
  }
}

export default new P2PService();