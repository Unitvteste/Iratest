
const express = require('express');
const path = require('path');

const app = express();

const IRACEMA_AI_BASE = 'https://worldecletix.onrender.com';

const IRACEMA_AI_MODELS = [
  "lady", "gpt-5.5", "grok-4.7", "grok-4-7", "grok-4.6",
  "grok-4-6", "grok-4-5", "gpt-6-astra", "gpt-6.1-sol",
  "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
  "gpt-5.6-luna", "gpt-5.4", "gpt-5.4-mini", "gpt-5",
  "gpt-5-chat-latest", "gpt-4o", "gpt-4o-2024-11-20",
  "gpt-4.1-mini", "gpt-4.1-nano", "gemini-4-argon",
  "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash",
  "gemini-3.5-flash", "gemini-3.1-pro",
  "gemini-3.1-pro-preview", "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite-preview", "gemini-3-flash",
  "gemini-3-flash-preview", "gemini-2.5-pro",
  "gemini-3.1-pro-preview-vertex", "gemini-2.5-pro-vertex",
  "deepseek-v4.1-flash", "deepseek-v4-pro",
  "deepseek-v4-pro-0813", "kimi-k3", "kimi-k2.7-code",
  "kimi-k2.6", "glm-5.3-flash", "glm-5.3", "glm-5.2",
  "minimax-m3", "qwen3.7-max"
];

const IRACEMA_AI_LADY_ERROR =
  /update copilot to continue|restart edge to get the latest version of copilot/i;

// Configurações
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Health check
app.get('/healthz', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'iracemaflix'
  });
});

// Informações da IracemaAI
app.get('/api/iracemaAI', (_req, res) => {
  res.json({
    name: 'IracemaAI',
    primary: 'lady',
    primaryLabel: 'IracemaAI',
    models: IRACEMA_AI_MODELS
  });
});

// Pesquisa YouTube
app.get('/api/iracemaAI/pesquisayt', async (req, res) => {
  const query = String(req.query.query || '').trim().slice(0, 160);

  if (!query) {
    return res.status(400).json({
      error: 'Informe o que deseja pesquisar'
    });
  }

  try {
    const upstream = await fetch(
      `${IRACEMA_AI_BASE}/api/pesquisayt?query=${encodeURIComponent(query)}`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'IracemaAI/1.0'
        },
        signal: AbortSignal.timeout(30000)
      }
    );

    res
      .status(upstream.status)
      .set('Access-Control-Allow-Origin', '*')
      .type('application/json')
      .send(await upstream.text());

  } catch (error) {
    res.status(502).json({
      error: `Pesquisa indisponível: ${error.message}`
    });
  }
});

// Música
app.get('/api/iracemaAI/musica', async (req, res) => {
  const name = String(req.query.name || '').trim().slice(0, 160);

  if (!name) {
    return res.status(400).json({
      error: 'Informe o nome da música'
    });
  }

  try {
    const upstream = await fetch(
      `${IRACEMA_AI_BASE}/api/musica?name=${encodeURIComponent(name)}`,
      {
        headers: {
          Accept: '*/*',
          'User-Agent': 'IracemaAI/1.0'
        },
        signal: AbortSignal.timeout(60000)
      }
    );

    const contentType =
      upstream.headers.get('content-type') || 'audio/mpeg';

    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    };

    if (String(req.query.download || '') === '1') {
      const filename = name
        .replace(/[^\p{L}\p{N}._ -]+/gu, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100) || 'musica';

      headers['Content-Disposition'] =
        `attachment; filename="${filename}.mp3"`;
    }

    res
      .status(upstream.status)
      .set(headers)
      .type(contentType)
      .send(Buffer.from(await upstream.arrayBuffer()));

  } catch (error) {
    res.status(502).json({
      error: `Serviço de música indisponível: ${error.message}`
    });
  }
});

// Modelos de IA
app.get('/api/iracemaAI/:model', async (req, res) => {
  const model = String(req.params.model || '');

  if (!IRACEMA_AI_MODELS.includes(model)) {
    return res.status(400).json({
      success: false,
      error: 'Modelo IracemaAI não disponível'
    });
  }

  const texto = String(req.query.texto || '').slice(0, 6000);

  if (!texto.trim()) {
    return res.status(400).json({
      success: false,
      error: 'Informe o texto para a IracemaAI'
    });
  }

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 60000);

  try {
    const upstream = await fetch(
      `${IRACEMA_AI_BASE}/api/${encodeURIComponent(model)}?texto=${encodeURIComponent(texto)}`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'IracemaAI/1.0'
        },
        signal: controller.signal
      }
    );

    const body = await upstream.text();

    // Fallback automático da Lady para GPT-5.5
    if (model === 'lady' && upstream.ok) {
      let parsed;

      try {
        parsed = JSON.parse(body);
      } catch (_) {
        parsed = null;
      }

      const ladyText = parsed && (
        parsed.resposta ||
        parsed.response ||
        parsed.message ||
        ''
      );

      if (IRACEMA_AI_LADY_ERROR.test(String(ladyText))) {
        const fallback = await fetch(
          `${IRACEMA_AI_BASE}/api/gpt-5.5?texto=${encodeURIComponent(texto)}`,
          {
            headers: {
              Accept: 'application/json',
              'User-Agent': 'IracemaAI/1.0'
            },
            signal: controller.signal
          }
        );

        const fallbackBody = await fallback.text();

        let fallbackParsed;

        try {
          fallbackParsed = JSON.parse(fallbackBody);
        } catch (_) {
          fallbackParsed = null;
        }

        if (fallback.ok && fallbackParsed) {
          const answer =
            fallbackParsed.response ||
            fallbackParsed.resposta ||
            fallbackParsed.message ||
            fallbackBody;

          return res
            .status(200)
            .set('Access-Control-Allow-Origin', '*')
            .json({
              success: true,
              model: 'lady',
              resposta: answer,
              response: answer,
              fallback: 'gpt-5.5'
            });
        }
      }
    }

    res
      .status(upstream.status)
      .set('Access-Control-Allow-Origin', '*')
      .type('application/json')
      .send(body);

  } catch (error) {
    res.status(502).json({
      success: false,
      error: error.name === 'AbortError'
        ? 'A IracemaAI demorou para responder'
        : `Falha na IracemaAI: ${error.message}`
    });

  } finally {
    clearTimeout(timer);
  }
});
app.get('/Iracema.html', (_req, res) => {
  res.sendFile(path.join(__dirname, 'Iracema.html'));
});
// Inicialização do servidor
const PORT = process.env.PORT || 7000;

app.listen(PORT, '0.0.0.0', () => {
  console.log('================================');
  console.log('       IRACEMAFLIX');
  console.log('       IRACEMA AI');
  console.log('================================');
  console.log(`Servidor iniciado na porta ${PORT}`);
  console.log('IracemaAI: /api/iracemaAI');
  console.log('Health: /healthz');
  console.log('Status: ONLINE');
});
  
