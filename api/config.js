export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    const binId = process.env.JSONBIN_BIN_ID || '6acb030dffd5d16053607ef6';

    if (!binId) {
        return res.status(500).json({ success: false, error: 'JSONBin Bin ID not configured on server' });
    }

    try {
        // Jika JSONBin Anda bersifat publik (Public Bin), header X-Master-Key tidak diperlukan sama sekali di sini.
        const response = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`);

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
