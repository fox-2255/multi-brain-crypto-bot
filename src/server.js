const express = require('express');
const cors = require('cors');
const defaultConfig = require('./config/defaultConfig.json');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/api/status', (req, res) => {
    res.json({ success: true, message: "Multi-Brain Server is Online!", status: "ACTIVE" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[MULTI-BRAIN SERVER] Running on port ${PORT}`));
