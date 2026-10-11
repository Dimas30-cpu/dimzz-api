export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    const { url, method = 'GET', headers = {}, body = null } = req.body;

    if (!url) {
        return res.status(400).json({ success: false, error: 'URL is required' });
    }

    try {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname;

        if (
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname.startsWith('10.') ||
            hostname.startsWith('192.168.') ||
            hostname.startsWith('169.254.')
        ) {
            return res.status(403).json({ success: false, error: 'Target URL is forbidden for security reasons.' });
        }
    } catch (e) {
        return res.status(400).json({ success: false, error: 'Invalid URL format' });
    }

    const startTime = Date.now();
    try {
        const fetchOptions = {
            method,
            headers: {
                'User-Agent': 'DIMZZ-API-HUB-Proxy/2.0',
                ...headers
            }
        };

        if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
            fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
        }

        const response = await fetch(url, fetchOptions);
        const responseTime = Date.now() - startTime;
        const responseContentType = response.headers.get('content-type') || '';
        
        let responseData;
        if (responseContentType.includes('application/json')) {
            responseData = await response.json();
        } else {
            responseData = await response.text();
        }

        return res.status(200).json({
            success: true,
            status: response.status,
            statusText: response.statusText,
            responseTime,
            data: responseData
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message,
            responseTime: Date.now() - startTime
        });
    }
}
