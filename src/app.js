// ─── State ───────────────────────────────────────────────────────────────────
let ws = null;
let audioContext = null;
let micStream = null;
let workletNode = null;
let playbackCtx = null;
let nextPlaybackTime = 0;
let currentResponseId = null;
let sessionInstructions = '';

// Connection config (populated from /api/token)
let openaiEndpoint = '';
let openaiDeployment = '';
let openaiApiVersion = '';

// Transcript tracking: maps response_id → DOM element (for streaming text)
const assistantEntries = new Map();
let currentUserEntry = null;

// ─── DOM Elements ────────────────────────────────────────────────────────────
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const statusEl = document.getElementById('status');
const modeLabel = document.getElementById('mode-label');
const voiceSelect = document.getElementById('voiceSelect');
const modeSelect = document.getElementById('modeSelect');
const pttContainer = document.getElementById('ptt-container');
const pttBtn = document.getElementById('pttBtn');
const transcriptEl = document.getElementById('transcript');
const canvas = document.getElementById('visualizer');
const canvasCtx = canvas.getContext('2d');

// ─── UI Helpers ──────────────────────────────────────────────────────────────
function setStatus(text, className) {
  statusEl.textContent = text;
  statusEl.className = `status ${className}`;
}

function addTranscriptEntry(role, text) {
  const div = document.createElement('div');
  div.className = `transcript-entry ${role}`;

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = role === 'user' ? 'You' : 'Assistant';

  const content = document.createElement('div');
  content.textContent = text;

  div.appendChild(label);
  div.appendChild(content);
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;

  return content;
}

function updateModeUI() {
  const isVAD = modeSelect.value === 'vad';
  pttContainer.classList.toggle('hidden', isVAD);
  modeLabel.textContent = isVAD ? 'Hands-free mode' : 'Push-to-talk mode';
}

// ─── Audio Helpers ───────────────────────────────────────────────────────────
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToInt16Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

function int16ToFloat32(int16Array) {
  const float32 = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32[i] = int16Array[i] / 32768;
  }
  return float32;
}

// ─── Playback ────────────────────────────────────────────────────────────────
function initPlayback() {
  playbackCtx = new AudioContext({ sampleRate: 24000 });
  nextPlaybackTime = 0;
}

function enqueueAudio(base64Audio) {
  if (!playbackCtx) return;

  const int16 = base64ToInt16Array(base64Audio);
  const float32 = int16ToFloat32(int16);

  const buffer = playbackCtx.createBuffer(1, float32.length, 24000);
  buffer.getChannelData(0).set(float32);

  const source = playbackCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackCtx.destination);

  const now = playbackCtx.currentTime;
  const startTime = Math.max(now, nextPlaybackTime);
  source.start(startTime);
  nextPlaybackTime = startTime + buffer.duration;
}

function stopPlayback() {
  if (playbackCtx) {
    playbackCtx.close().catch(() => {});
    playbackCtx = null;
  }
  nextPlaybackTime = 0;
}

function interruptPlayback() {
  // Reset playback so any queued audio is abandoned
  stopPlayback();
  initPlayback();
}

// ─── Visualizer ──────────────────────────────────────────────────────────────
let analyser = null;
let animFrameId = null;

function startVisualizer(stream) {
  const vizCtx = new AudioContext();
  const source = vizCtx.createMediaStreamSource(stream);
  analyser = vizCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    animFrameId = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArray);

    canvasCtx.fillStyle = '#1a1a1a';
    canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

    const barWidth = (canvas.width / bufferLength) * 2;
    let x = 0;
    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * canvas.height;
      canvasCtx.fillStyle = `hsl(160, 60%, ${30 + (dataArray[i] / 255) * 40}%)`;
      canvasCtx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);
      x += barWidth;
    }
  }
  draw();
}

function stopVisualizer() {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  canvasCtx.fillStyle = '#1a1a1a';
  canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
}

// ─── Microphone Capture ──────────────────────────────────────────────────────
async function startMicrophone() {
  // Use 24kHz to match OpenAI's expected sample rate
  audioContext = new AudioContext({ sampleRate: 24000 });
  await audioContext.audioWorklet.addModule('audio-processor.js');

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 24000,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });

  const source = audioContext.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(audioContext, 'audio-capture-processor');

  workletNode.port.onmessage = (event) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const pcm16Buffer = event.data;
    const base64 = arrayBufferToBase64(pcm16Buffer);

    ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: base64,
    }));
  };

  source.connect(workletNode);
  workletNode.connect(audioContext.destination); // needed for worklet to process

  // Start visualizer from the raw mic stream
  startVisualizer(micStream);
}

function stopMicrophone() {
  if (workletNode) {
    workletNode.disconnect();
    workletNode = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  stopVisualizer();
}

// ─── WebSocket & Session ─────────────────────────────────────────────────────
function sendSessionUpdate() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const isVAD = modeSelect.value === 'vad';

  const sessionConfig = {
    type: 'session.update',
    session: {
      modalities: ['text', 'audio'],
      voice: voiceSelect.value,
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      input_audio_transcription: {
        model: 'whisper-1',
      },
      turn_detection: isVAD
        ? { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 }
        : null,
      instructions: sessionInstructions,
      tools: [
        {
          type: 'function',
          name: 'lookup_info',
          description: 'Search the knowledge base for information. Use this when the user asks about products, policies, services, or any factual question that may be in the knowledge base.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query describing what information to look up',
              },
            },
            required: ['query'],
          },
        },
      ],
    },
  };

  ws.send(JSON.stringify(sessionConfig));
}

// ─── Tool Execution (client-side, calls Azure Function) ─────────────────────
async function executeToolCall(callId, name, args) {
  let output = 'No information found.';
  try {
    if (name === 'lookup_info') {
      const parsed = JSON.parse(args);
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: parsed.query }),
      });
      if (res.ok) {
        output = await res.text();
      } else {
        output = `Error searching knowledge base: ${res.statusText}`;
      }
    }
  } catch (err) {
    console.error('Tool execution error:', err);
    output = `Error looking up information: ${err.message}`;
  }

  // Send the function output directly to Azure OpenAI
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: output,
      },
    }));

    // Tell the model to continue generating a response
    ws.send(JSON.stringify({ type: 'response.create' }));
  }
}

function handleServerEvent(event) {
  switch (event.type) {
    case 'session.created':
      console.log('Session created:', event.session?.id);
      setStatus('Initialising...', 'connecting');
      sendSessionUpdate();
      break;

    case 'session.updated':
      console.log('Session configured');
      setStatus('Connected', 'connected');
      // Prompt the model to greet the caller immediately
      ws.send(JSON.stringify({ type: 'response.create' }));
      break;

    case 'response.audio.delta':
      enqueueAudio(event.delta);
      break;

    case 'response.audio_transcript.delta': {
      // Stream assistant transcript
      const rid = event.response_id;
      let entry = assistantEntries.get(rid);
      if (!entry) {
        entry = addTranscriptEntry('assistant', '');
        assistantEntries.set(rid, entry);
      }
      entry.textContent += event.delta;
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
      break;
    }

    case 'response.audio_transcript.done': {
      // Finalize the assistant entry
      const rid = event.response_id;
      assistantEntries.delete(rid);
      break;
    }

    case 'conversation.item.input_audio_transcription.completed': {
      // User's speech transcript
      if (event.transcript) {
        addTranscriptEntry('user', event.transcript.trim());
      }
      break;
    }

    case 'input_audio_buffer.speech_started':
      setStatus('Listening...', 'speaking');
      // Interrupt any ongoing playback if the user starts speaking
      interruptPlayback();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'response.cancel' }));
      }
      break;

    case 'input_audio_buffer.speech_stopped':
      setStatus('Processing...', 'connecting');
      break;

    case 'response.created':
      currentResponseId = event.response?.id;
      break;

    case 'response.function_call_arguments.done': {
      // Model wants to call a tool — execute via Azure Function and return result
      console.log(`Function call: ${event.name}(${event.arguments})`);
      setStatus('Looking up info...', 'connecting');
      executeToolCall(event.call_id, event.name, event.arguments);
      break;
    }

    case 'response.done':
      setStatus('Connected', 'connected');
      currentResponseId = null;
      break;

    case 'error':
      console.error('Server error:', event.error);
      addTranscriptEntry('assistant', `Error: ${event.error?.message || 'Unknown error'}`);
      break;

    default:
      // Uncomment to debug:
      // console.log('Unhandled event:', event.type);
      break;
  }
}

async function connect() {
  try {
    setStatus('Connecting...', 'connecting');
    connectBtn.disabled = true;

    // Fetch access token and connection config from Azure Function
    const tokenRes = await fetch('/api/token');
    if (!tokenRes.ok) {
      throw new Error('Failed to get access token from server');
    }
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.token;
    openaiEndpoint = tokenData.endpoint;
    openaiDeployment = tokenData.deployment;
    openaiApiVersion = tokenData.apiVersion;

    // Fetch instructions from Azure Function
    try {
      const res = await fetch('/api/instructions');
      if (res.ok) sessionInstructions = await res.text();
    } catch (err) {
      console.warn('Could not load instructions:', err);
    }

    // Start mic first so we can fail fast if permission denied
    await startMicrophone();
    initPlayback();

    // Connect directly to Azure OpenAI Realtime API
    const host = openaiEndpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const openaiUrl = `wss://${host}/openai/realtime?api-version=${openaiApiVersion}&deployment=${openaiDeployment}`;

    console.log('WebSocket URL:', openaiUrl);
    console.log('Token length:', accessToken?.length, 'Token prefix:', accessToken?.substring(0, 20) + '...');

    ws = new WebSocket(openaiUrl, ['realtime', `openai-insecure-api-key.${accessToken}`]);

    ws.onopen = () => {
      console.log('Connected directly to Azure OpenAI Realtime API');
      console.log('WebSocket protocol:', ws.protocol);
      disconnectBtn.disabled = false;
      pttBtn.disabled = false;
    };

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        handleServerEvent(event);
      } catch (err) {
        console.error('Failed to parse server message:', err);
      }
    };

    ws.onclose = (event) => {
      console.log('Disconnected from Azure OpenAI');
      console.log('WebSocket close code:', event.code, 'reason:', event.reason || '(none)', 'wasClean:', event.wasClean);
      cleanup();
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      // Also try the v1 endpoint format as a probe
      const v1Url = `https://${host}/openai/v1/realtime?model=${openaiDeployment}`;
      const oldUrl = openaiUrl.replace('wss://', 'https://');
      
      Promise.all([
        fetch(oldUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } })
          .then(r => r.text().then(b => console.log(`HTTP probe (old format) status: ${r.status}, body: ${b.substring(0, 300)}`))),
        fetch(v1Url, { headers: { 'Authorization': `Bearer ${accessToken}` } })
          .then(r => r.text().then(b => console.log(`HTTP probe (v1 format) status: ${r.status}, body: ${b.substring(0, 300)}`)))
      ]).catch(e => console.log('HTTP probe failed:', e.message));
      cleanup();
    };
  } catch (err) {
    console.error('Connection failed:', err);
    setStatus('Error: ' + err.message, 'disconnected');
    cleanup();
  }
}

function cleanup() {
  stopMicrophone();
  stopPlayback();

  if (ws) {
    ws.close();
    ws = null;
  }

  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  pttBtn.disabled = true;
  setStatus('Disconnected', 'disconnected');
  assistantEntries.clear();
  currentResponseId = null;
  currentUserEntry = null;
}

// ─── Push-to-Talk ────────────────────────────────────────────────────────────
function pttStart() {
  pttBtn.classList.add('active');
  pttBtn.textContent = 'Listening...';
}

function pttStop() {
  pttBtn.classList.remove('active');
  pttBtn.textContent = 'Hold to Talk';

  // Commit the audio buffer to signal end of speech
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    ws.send(JSON.stringify({ type: 'response.create' }));
  }
}

// ─── Event Listeners ─────────────────────────────────────────────────────────
connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', cleanup);
modeSelect.addEventListener('change', () => {
  updateModeUI();
  sendSessionUpdate();
});

// PTT mouse events
pttBtn.addEventListener('mousedown', pttStart);
pttBtn.addEventListener('mouseup', pttStop);
pttBtn.addEventListener('mouseleave', () => {
  if (pttBtn.classList.contains('active')) pttStop();
});

// PTT touch events (mobile)
pttBtn.addEventListener('touchstart', (e) => {
  e.preventDefault();
  pttStart();
});
pttBtn.addEventListener('touchend', (e) => {
  e.preventDefault();
  pttStop();
});

// PTT keyboard (spacebar)
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && modeSelect.value === 'ptt' && !pttBtn.disabled && !e.repeat) {
    e.preventDefault();
    pttStart();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && modeSelect.value === 'ptt' && pttBtn.classList.contains('active')) {
    e.preventDefault();
    pttStop();
  }
});

// Initialize UI
updateModeUI();
