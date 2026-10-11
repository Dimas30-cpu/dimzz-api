export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    const binId = process.env.JSONBIN_BIN_ID;
    const apiKey = process.env.JSONBIN_PUBLIC_KEY;

    if (!binId) {
        return res.status(500).json({ success: false, error: 'JSONBin Bin ID not configured on server' });
    }

    try {
        const response = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
            headers: apiKey ? { 'X-Master-Key': apiKey } : {}
        });

        if (!response.ok) {
            throw new Error('Failed to fetch from JSONBin');
        }

        const data = await response.json();
        return res.status(200).json({
            success: true,
            endpoints: data.record.endpoints || []
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
}
