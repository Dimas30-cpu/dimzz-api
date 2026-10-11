export default async function handler(req, res) {
    const { path } = req.query;
    let requestedPath = '';

    if (path) {
        requestedPath = '/' + (Array.isArray(path) ? path.join('/') : path);
    } else {
        const parsedFullUrl = new URL(req.url, `https://${req.headers.host}`);
        requestedPath = parsedFullUrl.pathname;
    }

    requestedPath = '/' + requestedPath.replace(/^\/+/, '').replace(/\/+$/, '');

    if (req.method === 'POST' && req.body && req.body.url && (requestedPath === '/' || requestedPath === '/api' || requestedPath === '/api/proxy')) {
        return handleLegacyProxy(req, res);
    }

    const binId = process.env.JSONBIN_BIN_ID || '6acb030dffd5d16053607ef6';
    const apiKey = process.env.JSONBIN_PUBLIC_KEY;

    try {
        const configRes = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
            headers: apiKey ? { 'X-Master-Key': apiKey } : {}
        });

        if (!configRes.ok) {
            throw new Error('Failed to fetch endpoint configurations from JSONBin');
        }

        const configData = await configRes.json();
        const endpoints = configData.record.endpoints || [];

        const matchedEp = endpoints.find(ep => {
            const isEnabled = ep.enabled === true || ep.enabled === 'true';
            const isPublic = ep.public === true || ep.public === 'true';
            if (!isEnabled || !isPublic) return false;

            let epSlug = ep.slug || '';
            if (!epSlug && (ep.url || ep.sourceUrl)) {
                try {
                    epSlug = new URL(ep.url || ep.sourceUrl).pathname;
                } catch (e) {
                    epSlug = '';
                }
            }
            epSlug = '/' + epSlug.replace(/^\/+/, '').replace(/\/+$/, '');

            return requestedPath === epSlug || requestedPath === ('/api' + epSlug) || ('/api' + requestedPath) === epSlug;
        });

        if (!matchedEp) {
            return res.status(404).json({
                success: false,
                error: `Endpoint not found or disabled for path: ${requestedPath}`
            });
        }

        if (matchedEp.method && matchedEp.method.toUpperCase() !== req.method.toUpperCase()) {
            return res.status(405).json({
                success: false,
                error: `Method ${req.method} not allowed. Expected ${matchedEp.method}`
            });
        }

        const targetSourceUrl = matchedEp.url || matchedEp.sourceUrl;
        if (!targetSourceUrl) {
            return res.status(500).json({ success: false, error: 'Target source URL is not configured for this endpoint.' });
        }

        const incomingUrlObj = new URL(req.url, `https://${req.headers.host}`);
        const targetUrlObj = new URL(targetSourceUrl);

        // 1. Terapkan Parameter Mapping jika dikonfigurasi admin (misal: {"text": "prompt"})
        const mapping = matchedEp.parameterMapping || {};
        incomingUrlObj.searchParams.forEach((value, key) => {
            const mappedKey = mapping[key] || key;
            targetUrlObj.searchParams.set(mappedKey, value);
        });

        // 2. Validasi Parameter Wajib (requiredParams)
        const requiredParams = matchedEp.requiredParams || [];
        for (const reqParam of requiredParams) {
            const effectiveKey = Object.keys(mapping).find(k => mapping[k] === reqParam) || reqParam;
            if (!targetUrlObj.searchParams.has(reqParam) && !incomingUrlObj.searchParams.has(effectiveKey)) {
                return res.status(400).json({
                    success: false,
                    error: `Missing required parameter: '${reqParam}' (or mapped equivalent)`
                });
            }
        }

        const finalTargetUrl = targetUrlObj.toString();

        // Validasi Keamanan SSRF
        const hostname = targetUrlObj.hostname;
        if (
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname.startsWith('10.') ||
            hostname.startsWith('192.168.') ||
            hostname.startsWith('169.254.') ||
            !targetUrlObj.protocol.startsWith('https')
        ) {
            return res.status(403).json({ success: false, error: 'Forbidden: Target URL violates security policies.' });
        }

        // Susun Headers & Autentikasi Universal
        const headers = {
            'User-Agent': 'DIMZZ-API-HUB-Universal-Adapter/2026',
            ...(matchedEp.headers || {})
        };

        if (matchedEp.auth) {
            if (matchedEp.auth.type === 'bearer' && matchedEp.auth.token) {
                headers['Authorization'] = `Bearer ${matchedEp.auth.token}`;
            } else if (matchedEp.auth.type === 'apikey' && matchedEp.auth.key && matchedEp.auth.value) {
                headers[matchedEp.auth.key] = matchedEp.auth.value;
            }
        }

        const startTime = Date.now();
        const fetchOptions = {
            method: matchedEp.method || 'GET',
            headers
        };

        if (['POST', 'PUT', 'PATCH'].includes(fetchOptions.method)) {
            if (req.body && Object.keys(req.body).length > 0) {
                fetchOptions.headers['Content-Type'] = matchedEp.bodyType === 'form' ? 'application/x-www-form-urlencoded' : 'application/json';
                if (matchedEp.bodyType === 'form') {
                    const formBody = new URLSearchParams(req.body).toString();
                    fetchOptions.body = formBody;
                } else {
                    fetchOptions.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
                }
            }
        }

        const timeoutLimit = matchedEp.timeout || 15000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutLimit);
        fetchOptions.signal = controller.signal;

        let externalRes;
        try {
            externalRes = await fetch(finalTargetUrl, fetchOptions);
            clearTimeout(timeoutId);
        } catch (fetchErr) {
            clearTimeout(timeoutId);
            return res.status(504).json({ success: false, error: `Gateway Timeout or Network Error: ${fetchErr.message}` });
        }

        const responseTime = Date.now() - startTime;
        const contentType = externalRes.headers.get('content-type') || '';
        const responseTypeConfig = matchedEp.responseType || 'auto';

        let responseData;
        if (responseTypeConfig === 'binary' || contentType.includes('image/') || contentType.includes('audio/') || contentType.includes('video/')) {
            const arrayBuffer = await externalRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            res.setHeader('Content-Type', contentType);
            return res.status(externalRes.status).send(buffer);
        }

        const responseText = await externalRes.text();

        if (responseTypeConfig === 'text' || (!contentType.includes('application/json') && !responseText.trim().startsWith('{') && !responseText.trim().startsWith('['))) {
            responseData = {
                contentType,
                output: responseText
            };
        } else {
            try {
                responseData = JSON.parse(responseText);
            } catch (jsonErr) {
                responseData = {
                    warning: "Target server returned invalid JSON",
                    contentType,
                    rawOutput: responseText.substring(0, 1000)
                };
            }
        }

        return res.status(externalRes.status).json({
            success: externalRes.ok,
            status: externalRes.status,
            statusText: externalRes.statusText,
            responseTime,
            data: responseData
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
}

async function handleLegacyProxy(req, res) {
    const { url, method = 'GET', headers = {}, body = null } = req.body;
    try {
        const targetObj = new URL(url);
        if (['localhost', '127.0.0.1'].includes(targetObj.hostname)) {
            return res.status(403).json({ success: false, error: 'Forbidden target' });
        }
        const start = Date.now();
        const resp = await fetch(url, {
            method,
            headers: { 'User-Agent': 'DIMZZ-Legacy-Proxy', ...headers },
            body: body && ['POST', 'PUT', 'PATCH'].includes(method) ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
        });
        const text = await resp.text();
        let data;
        try { data = JSON.parse(text); } catch(e) { data = { rawOutput: text.substring(0, 1000) }; }
        return res.status(200).json({ success: resp.ok, status: resp.status, responseTime: Date.now() - start, data });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
}
