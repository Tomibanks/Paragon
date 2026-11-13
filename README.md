# The Paragons website + blog admin

## What is in this folder
- `public/index.html`   the website
- `public/admin.html`   the admin page for blog posts, Daily Nuggets and Visitors (you open it at `/admin`)
- `public/_redirects`   makes `/admin` open the admin page
- `netlify/functions/api.mjs`   the small service that saves blog posts and nuggets and counts visitors
- `netlify.toml` and `package.json`   settings Netlify reads (no need to change these)

## Easiest way to put it online (no coding)
You need a free GitHub account and your Netlify account.

1. Unzip this file on your computer.
2. Go to github.com, sign in, click the **+** (top right) then **New repository**.
   Name it `paragons-website`, choose **Private**, click **Create repository**.
3. On the next page click **uploading an existing file**.
   Open the unzipped `paragons-site` folder and drag everything inside it
   (the `netlify` folder, the `public` folder, `netlify.toml`, `package.json`, `README.md`)
   into the browser window. Wait for the upload, then click **Commit changes**.
4. Go to app.netlify.com. Click **Add new project**, then **Import an existing project**,
   then **GitHub**. Allow access and pick `paragons-website`.
5. Do not change any settings. Click **Deploy**. Wait one or two minutes until it says **Published**.
6. Open your new site address and add `/admin` to the end. That is your admin page.

## Keeping the same address (ehccparagon.netlify.app)
A site made by dragging a folder cannot be switched to GitHub, so Netlify makes a new site.
Before step 4, rename the old one: open the old site, **Site configuration**, **Change site name**,
and call it something else (for example `ehccparagon-old`). After step 5, open the new site,
**Site configuration**, **Change site name**, and type `ehccparagon`.

## Adding Daily Nuggets
1. Open `your-site-address/admin` and tap **Daily nuggets** at the top.
2. Add the nugget picture, type the Bible reference (for example John 3:16) and press **Add nugget**.
3. It shows first in Paragon Daily Nuggets on the website. A **Read verse** button appears when you add a reference.
4. Optional: type the verse text (only text you are allowed to use). People then see it when they tap **Read verse**. If you leave it empty, the site shows the KJV for verses it already knows, or a link to read it online.

## Seeing your visitors
Open `your-site-address/admin` and tap **Visitors**. You will see visitors and page views today and over the last 7, 30 or 90 days, a daily chart, the pages and blog posts people read, where they came from (Google, WhatsApp, Instagram and so on), their countries, whether they use phones or computers, and how many tapped Join WhatsApp, Instagram, Register or Share.
- The numbers are anonymous: no names, no cookies, no IP addresses are saved.
- A visitor is counted once per day. Robots, search engines and the admin page itself are not counted. People who switch on "Do Not Track" in their browser are not counted.
- Numbers only start counting after the site is live on Netlify with this version.

## Writing a post
1. Open `your-site-address/admin`.
2. Type the title, write or paste the article, add a picture if you like.
3. Press **Publish post**. It appears on the website Blog page straight away.

Formatting: press Enter for each new paragraph. Start a line with `##` for a heading, `-` for a bullet,
`>` for a highlighted line. Put `**double stars**` round words to make them bold. Links become clickable by themselves.

## Changing the website later
In your GitHub repository open the `public` folder, click `index.html`, then the pencil or **Upload files**
and replace it. Netlify republishes by itself in a minute.

## Good to know
- Dragging a folder straight onto Netlify shows the pages but cannot save blog posts. That is why GitHub is used.
- There is no login. Anyone who knows the `/admin` address can add or delete posts, so keep it private.
  If you want a passcode, in Netlify go to **Site configuration, Environment variables**, add one named
  `ADMIN_PASSCODE`, then redeploy. The admin page will ask for it.
- Your first post is built into the website and always shows at the bottom of the list.
