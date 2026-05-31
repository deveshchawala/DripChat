# DripChat - Personal AI Wardrobe Assistant

DripChat is a client-side, chat-based AI assistant designed to suggest outfits based on your personal wardrobe. 

Built with **zero server costs**, **100% local privacy**, and **minimal AI overhead**, DripChat runs entirely inside your smartphone's browser or seamlessly as a **Telegram Mini App (TMA)**. Your clothes and photos are stored securely on your device, and it connects directly to a free Gemini API key to deliver smart fashion suggestions.

---

## 🚀 Key Features

* 📱 **Mobile-First Glassmorphic Design**: An incredibly sleek, native-like interface featuring bottom navigation tabs optimized for touchscreens.
* 📦 **IndexedDB Photo Storage**: Stores photos of your clothes locally in your browser's private database. No image upload limits and 100% serverless!
* ⚡ **Client-Side Image Compression**: Automatically compresses uploaded photos to keep database storage lightweight and loading times instant.
* 📸 **AI Multimodal Auto-Tagging**: Simply snap a picture of your clothes, and the AI (Gemini Vision) will analyze it once to auto-detect its color, category, style, and season.
* 💬 **Smart Outfit Generator**: Chat with DripChat, describe the weather or occasion, and get customized outfit suggestions made *exclusively* from items in your actual wardrobe.
* 🛍️ **Wardrobe Gap Analysis**: A dedicated recommendation tool where the AI analyzes your collection to identify missing pieces and suggest your next strategic purchases.
* 🔒 **Absolute Privacy & Portability**: Your data never leaves your device. Easily export or import your complete wardrobe collection as a portable JSON file.
 
---

## 🛠️ Quick Start (Local Run)

1. Clone or download the project files into a folder.
2. Double-click **`index.html`** to open it directly in Google Chrome, Safari, Firefox, or Edge.
3. Go to the **Settings** tab (⚙️) and enter a free **Gemini API Key**.
4. Start adding items and enjoy your AI Stylist!

---

## 🔑 How to Get a Free Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/).
2. Log in with your Google account.
3. Click **Get API Key** at the top left.
4. Click **Create API Key**, copy it, and paste it into the **DripChat Settings Panel**.

---

## 🤖 How to Launch as a Telegram Mini App

You can deploy DripChat and run it directly inside Telegram as an app. Here is how to configure it in under 3 minutes:

### Step 1: Host Your Files (Free)
Because DripChat is a static site (HTML/CSS/JS), you can host it for free on Vercel, Netlify, or GitHub Pages:
* **Vercel**: Install Vercel CLI and run `vercel` in the project directory, or link your GitHub repo for instant automatic hosting.
* **GitHub Pages**: Upload the files to a public GitHub repository, go to `Settings > Pages`, and enable deployment from the `main` branch.
* *Copy the deployment URL (e.g. `https://my-dripchat.vercel.app`).*

### Step 2: Register a Telegram Bot using `@BotFather`
1. Open Telegram and search for the official account **`@BotFather`**.
2. Click **Start** and send the command `/newbot`.
3. Give your bot a stylish name (e.g. `My Drip AI`) and a username ending in `bot` (e.g. `MyDripChatBot`).
4. `@BotFather` will give you an API Token. (Keep this safe if you need to run server bots, though DripChat doesn't need it since it is purely client-side!).

### Step 3: Link Your Mini App
1. In your chat with **`@BotFather`**, send the command `/newapp`.
2. Choose your newly created bot.
3. Enter a title for your app (e.g., `DripChat`) and a short description.
4. Upload a square image icon (150x150 px) when requested.
5. Enter the hosted URL you copied in **Step 1** (e.g. `https://my-dripchat.vercel.app`).
6. Choose a short name for your web app link (e.g., `app`).
7. **Done!** `@BotFather` will give you a link (e.g. `t.me/MyDripChatBot/app`). Open this link on your smartphone or desktop to launch your personalized wardrobe assistant inside Telegram!

---

## 🎨 Styling Customizations
If you want to customize colors or fonts, all design variables are mapped as clean CSS variables in **`styles.css`** under `:root`. When opened inside Telegram, DripChat automatically reads the active Telegram chat colors (dark or light mode) to seamlessly match your personal messenger layout!
