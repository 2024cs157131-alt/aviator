# Crown Pesa Aviator — Railway Deployment Guide

## Prerequisites
- GitHub account with this repo pushed
- Railway account at railway.app

## Step 1 — Push to GitHub
```bash
git add -A
git commit -m "Initial deploy"
git push
```

## Step 2 — Create Railway Project
1. railway.app → New Project → Deploy from GitHub repo
2. Select your repo → Deploy Now

## Step 3 — Add MySQL Database
Railway canvas → + New → Database → MySQL
Wait 30 seconds for it to start.

## Step 4 — Set Environment Variables
Click your **app service** → Variables tab → add:

| Variable              | Value                              |
|-----------------------|------------------------------------|
| DB_HOST               | from MySQL service Variables tab   |
| DB_PORT               | from MySQL service Variables tab   |
| DB_NAME               | from MySQL service Variables tab   |
| DB_USER               | from MySQL service Variables tab   |
| DB_PASS               | from MySQL service Variables tab   |
| SESSION_SECRET        | 64-char random string              |
| JWT_SECRET            | different 64-char random string    |
| NODE_ENV              | production                         |
| PAYSTACK_PUBLIC_KEY   | pk_live_... from paystack.com      |
| PAYSTACK_SECRET_KEY   | sk_live_... from paystack.com      |

⚠️  Do NOT set PORT — Railway sets it automatically.
⚠️  pk_ goes in PUBLIC_KEY, sk_ goes in SECRET_KEY (easy to swap!)

Generate secrets at: https://generate.plus/en/password (set length 64)

## Step 5 — Get Your URL
App service → Settings → Networking → Generate Domain

## Step 6 — Make Yourself Admin
1. Register an account on the live site
2. Railway → MySQL service → Query tab, run:
```sql
UPDATE users SET is_admin=1 WHERE email='your@email.com';
```
3. Log out and log back in → Admin button appears in nav

## Step 7 — Seed Demo Users (optional, for marketing)
Admin panel → "Seed Demo Users" button → runs once

## Expected Startup Logs
```
🚀 Crown Pesa Aviator listening on port XXXX
✅ Database connected successfully
✅ Database schema ready
🎮 Game engine started
✅ Crown Pesa Aviator FULLY READY
```
