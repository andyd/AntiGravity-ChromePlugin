document.addEventListener('DOMContentLoaded', async () => {
    // Elements
    const summarizeBtn = document.getElementById('summarizeBtn');
    const statusText = document.getElementById('statusText');
    const statusContainer = document.getElementById('statusContainer');
    const loader = document.getElementById('loader');

    const settingsBtn = document.getElementById('settingsBtn');
    const settingsPanel = document.getElementById('settingsPanel');
    const mainContent = document.getElementById('mainContent');
    const apiKeyInput = document.getElementById('apiKey');
    const saveKeyBtn = document.getElementById('saveKeyBtn');

    // State
    let API_KEY = "";

    // Initialization
    await loadApiKey();

    // Listeners
    settingsBtn.addEventListener('click', toggleSettings);
    saveKeyBtn.addEventListener('click', saveApiKey);
    summarizeBtn.addEventListener('click', handleSummarize);

    // --- Handlers ---

    function toggleSettings() {
        const isHidden = settingsPanel.classList.contains('hidden');
        if (isHidden) {
            settingsPanel.classList.remove('hidden');
            mainContent.classList.add('hidden');
        } else {
            settingsPanel.classList.add('hidden');
            mainContent.classList.remove('hidden');
        }
    }

    async function loadApiKey() {
        const data = await chrome.storage.sync.get(['geminiApiKey']);
        if (data.geminiApiKey) {
            API_KEY = data.geminiApiKey;
            apiKeyInput.value = API_KEY;
        } else {
            // If no key, maybe open settings automatically? 
            // Let's just set a status message
            setStatus("Please set your Gemini API Key in settings.", "warning");
        }
    }

    async function saveApiKey() {
        const key = apiKeyInput.value.trim();
        if (!key) return;

        await chrome.storage.sync.set({ geminiApiKey: key });
        API_KEY = key;

        // UI Feedback
        const originalText = saveKeyBtn.textContent;
        saveKeyBtn.textContent = "Saved!";
        saveKeyBtn.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--success-color');

        setTimeout(() => {
            saveKeyBtn.textContent = originalText;
            saveKeyBtn.style.backgroundColor = "";
            toggleSettings(); // Close settings
            setStatus("Ready to summarize", "normal");
        }, 1000);
    }

    async function handleSummarize() {
        if (!API_KEY) {
            setStatus("Missing API Key. Click 'Settings' to add it.", "error");
            toggleSettings(); // Force open settings
            return;
        }

        setLoading(true);
        setStatus("Extracting content...", "normal");

        try {
            // 1. Get Tab
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) throw new Error("No active tab found");

            // 2. Ensure Content Script
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['content.js']
                });
            } catch (e) {
                console.log("Injection skipped:", e);
            }

            // 3. Get Content
            const response = await chrome.tabs.sendMessage(tab.id, { action: "GET_CONTENT" });
            if (!response || !response.content) {
                throw new Error("Could not extract content from page.");
            }

            setStatus("Asking Gemini...", "normal");

            // 4. Call Gemini API
            const summary = await callGeminiAPI(response.content);

            // 5. Handle Options
            const shouldSave = document.getElementById('saveFile').checked;
            const shouldCopy = document.getElementById('copyClipboard').checked;

            if (shouldSave) {
                saveToFile(response.url, response.content, summary);
            }

            if (shouldCopy) {
                await navigator.clipboard.writeText(summary);
            }

            // 6. Open Window
            openSummaryWindow(response.title, response.url, response.content, summary);

            setLoading(false);
            showSuccess("Done! Summary ready.");

        } catch (err) {
            console.error(err);
            setLoading(false);
            setStatus("Error: " + err.message, "error");
        }
    }

    // --- API Logic ---

    // Cache valid model if found
    let validModelName = null;

    async function checkModels() {
        if (!API_KEY) {
            alert("Please enter an API Key first.");
            return null;
        }

        const listEndpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`;
        try {
            const response = await fetch(listEndpoint);
            const data = await response.json();

            if (!response.ok) {
                console.error("ListModels failed", data);
                return null;
            }

            if (data.models) {
                // Find models that support generateContent
                const capableModels = data.models.filter(m =>
                    m.supportedGenerationMethods &&
                    m.supportedGenerationMethods.includes("generateContent")
                );

                // Return just the names
                return capableModels.map(m => m.name.replace("models/", ""));
            }
            return [];
        } catch (e) {
            console.error("Error checking models", e);
            return null;
        }
    }

    async function callGeminiAPI(text) {
        // Models to try in order of preference
        let modelsToTry = [
            'gemini-1.5-flash',
            'gemini-1.5-flash-latest',
            'gemini-pro'
        ];

        // If we already found a working model, put it first
        if (validModelName) {
            modelsToTry = [validModelName];
        }

        let lastError = null;

        // 1. Try preferred models
        for (const model of modelsToTry) {
            try {
                return await tryGenerateContent(model, text);
            } catch (e) {
                console.log(`Model ${model} failed, trying next...`, e.message);
                lastError = e;
                if (!e.message.includes("not found") && !e.message.includes("not supported")) {
                    // If it's a profound error (like Auth), don't keep guessing models
                    throw e;
                }
            }
        }

        // 2. If all failed, dynamically fetch available models for this key
        setStatus("Finding compatible model...", "warning");
        const availableModels = await checkModels();

        if (availableModels && availableModels.length > 0) {
            console.log("Found available models:", availableModels);
            // Try the first one we find
            const fallbackModel = availableModels[0];
            try {
                const result = await tryGenerateContent(fallbackModel, text);
                // It worked! Remember this model.
                validModelName = fallbackModel;
                return result;
            } catch (e) {
                lastError = e;
            }
        }

        throw new Error(`Could not find any working Gemini model. Last error: ${lastError?.message || "Unknown"}`);
    }

    async function tryGenerateContent(modelName, text) {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${API_KEY}`;

        const maxLength = 100000;
        const truncatedText = text.slice(0, maxLength);

        const payload = {
            contents: [{
                parts: [{
                    text: `Please provide a **highly detailed and verbose summary** of the following web page content. 
                    
                    Structure:
                    1. **Executive Summary**: A high-level overview.
                    2. **Key Points**: Detailed bullet points of the main arguments/facts.
                    3. **Analysis/Details**: deep dive into the specific content.
                    
                    Format the output with Markdown.
                    
                    Content: \n\n${truncatedText}`
                }]
            }]
        };

        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok) {
            let msg = data.error?.message || "Unknown API Error";
            throw new Error(msg);
        }

        const candidates = data.candidates;
        if (candidates && candidates.length > 0) {
            return candidates[0].content.parts[0].text;
        } else {
            throw new Error("No summary returned from Gemini.");
        }
    }

    // --- Helpers ---

    function saveToFile(url, originalContent, summary) {
        // Add date
        const dateStr = new Date().toLocaleString();
        const fileContent = `ANTI-GRAVITY SUMMARY\nGenerated: ${dateStr}\n` +
            `Source: ${url}\n\n` +
            `SUMMARY:\n===================\n${summary}\n\n` +
            `ORIGINAL CONTENT:\n===================\n${originalContent}`;

        const blob = new Blob([fileContent], { type: 'text/plain' });
        const reader = new FileReader();
        reader.onload = function () {
            chrome.downloads.download({
                url: reader.result,
                filename: 'summary-' + Date.now() + '.txt',
                saveAs: false
            });
        };
        reader.readAsDataURL(blob);
    }

    function openSummaryWindow(title, url, originalContent, summary) {
        // Convert markdown (basic) to HTML for display
        let html = summary
            .replace(/^### (.*$)/gim, '<h3>$1</h3>')
            .replace(/^## (.*$)/gim, '<h2>$1</h2>')
            .replace(/^# (.*$)/gim, '<h1>$1</h1>')
            .replace(/\*\*(.*)\*\*/gim, '<b>$1</b>')
            .replace(/\*(.*)\*/gim, '<i>$1</i>')
            .replace(/\n\n/gim, '<p></p>')
            .replace(/\n/gim, '<br>');

        // Basic safety escape for original content
        const safeOriginal = (originalContent || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");

        const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Summary: ${title}</title>
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
            max-width: 900px; 
            margin: 0 auto; 
            padding: 40px; 
            line-height: 1.6; 
            color: #1f2937; 
            background-color: #f3f4f6;
          }
          .container {
            background: white;
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); 
          }
          h1 { border-bottom: 2px solid #e5e7eb; padding-bottom: 10px; color: #111827; margin-top: 0; }
          h2 { color: #374151; margin-top: 30px; border-bottom: 1px solid #eee; padding-bottom: 5px; }
          h3 { color: #4b5563; margin-top: 20px; }
          p { margin-bottom: 1em; }
          
          .meta-box {
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 30px;
            font-size: 0.9em;
          }
          .meta-row { display: flex; gap: 10px; margin-bottom: 5px; }
          .meta-label { font-weight: 600; color: #64748b; min-width: 80px; }
          .meta-value { color: #334155; word-break: break-all; }
          .meta-value a { color: #2563eb; text-decoration: none; }
          .meta-value a:hover { text-decoration: underline; }

          .full-content-section {
            margin-top: 60px;
            border-top: 4px solid #e5e7eb;
            padding-top: 30px;
          }
          .full-content-box {
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            padding: 20px;
            border-radius: 8px;
            font-family: monospace;
            white-space: pre-wrap;
            font-size: 0.85em;
            max-height: 600px;
            overflow-y: auto;
            color: #475569;
          }
          
          .footer { margin-top: 50px; padding-top: 20px; border-top: 1px solid #e5e7eb; font-size: 0.8em; color: #9ca3af; text-align: center; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Summary: ${title}</h1>
          
          <div class="meta-box">
             <div class="meta-row">
               <div class="meta-label">Source URL:</div>
               <div class="meta-value"><a href="${url}" target="_blank">${url}</a></div>
             </div>
             <div class="meta-row">
               <div class="meta-label">Date:</div>
               <div class="meta-value">${new Date().toLocaleString()}</div>
             </div>
          </div>

          <div class="content">
            ${html}
          </div>

          <div class="full-content-section">
            <h2>Original Page Content</h2>
            <div class="full-content-box">${safeOriginal}</div>
          </div>

          <div class="footer">Powered by Gemini 1.5 Flash • AntiGravity Summarizer</div>
        </div>
      </body>
      </html>
    `;

        const blob = new Blob([htmlContent], { type: 'text/html' });
        const urlObj = URL.createObjectURL(blob);
        window.open(urlObj, '_blank');
    }

    function setLoading(isLoading) {
        summarizeBtn.disabled = isLoading;
        loader.hidden = !isLoading;
        if (isLoading) {
            statusContainer.style.backgroundColor = "#e2e8f0";
            statusText.style.color = "#1e293b";
        }
    }

    function setStatus(msg, type) {
        statusText.textContent = msg;
        if (type === "error") {
            statusContainer.style.backgroundColor = "#fee2e2";
            statusText.style.color = "#dc2626";
        } else if (type === "warning") {
            statusContainer.style.backgroundColor = "#fef3c7";
            statusText.style.color = "#d97706";
        } else {
            statusContainer.style.backgroundColor = "#f1f5f9";
            statusText.style.color = "#475569";
        }
    }

    function showSuccess(msg) {
        statusContainer.style.backgroundColor = "rgba(16, 185, 129, 0.1)";
        statusText.textContent = msg;
        statusText.style.color = "#10b981";
    }
});
