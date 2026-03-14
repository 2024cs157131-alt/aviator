# Crown Pesa Aviator — Namecheap Hosting Guide
# ════════════════════════════════════════════════
# Complete step-by-step for a beginner
# ════════════════════════════════════════════════

## THE IMPORTANT TRUTH FIRST

Namecheap SHARED hosting (Stellar, Stellar Plus) CANNOT run this app.
Shared hosting only supports PHP + MySQL. Node.js needs a persistent process.

You have THREE options with Namecheap:
  Option A → Namecheap VPS (recommended, ~$6–12/month)
  Option B → Railway.app FREE tier (easiest, no server management)
  Option C → Render.com FREE tier (also easy)

This guide covers all three. Start with Option B if you want it running TODAY.

════════════════════════════════════════════════════════════════════
OPTION B — RAILWAY.APP (Fastest, Free to start)
════════════════════════════════════════════════════════════════════

STEP 1: Create a free account at railway.app

STEP 2: Install Railway CLI on your computer
  Windows: Open PowerShell as Administrator, run:
    npm install -g @railway/cli

  Mac/Linux: Open Terminal, run:
    curl -fsSL https://railway.app/install.sh | sh

STEP 3: Upload your code to GitHub (Railway deploys from GitHub)
  a) Go to github.com and create a free account
  b) Create a new repository called "crownpesa-aviator"
  c) Upload the entire crownpesa/ folder to GitHub

STEP 4: In Railway dashboard:
  a) Click "New Project" → "Deploy from GitHub repo"
  b) Select your crownpesa-aviator repository
  c) Railway auto-detects Node.js and runs: npm start

STEP 5: Add a MySQL database
  a) In your Railway project, click "+ New Service"
  b) Select "Database" → "MySQL"
  c) Railway creates a database and gives you connection details

STEP 6: Set environment variables in Railway
  a) Click your app service → "Variables" tab
  b) Add each line from your .env file:
     DB_HOST=     (paste from Railway MySQL service)
     DB_PORT=     (paste from Railway MySQL service)
     DB_NAME=     (paste from Railway MySQL service)
     DB_USER=     (paste from Railway MySQL service)
     DB_PASS=     (paste from Railway MySQL service)
     JWT_SECRET=  your_long_random_string_here
     SESSION_SECRET= another_random_string
     PAYSTACK_PUBLIC_KEY=  your key
     PAYSTACK_SECRET_KEY=  your key
     PORT=3000
     NODE_ENV=production

STEP 7: Your app is live!
  Railway gives you a URL like: crownpesa-aviator.up.railway.app
  Visit it and the game runs immediately.

STEP 8: Point your Namecheap domain to Railway
  a) In Railway: Settings → Domains → Add Custom Domain
  b) Type: aviator.surveynx.com
  c) Railway shows you a CNAME value like: xyz.railway.app

  d) Go to Namecheap Dashboard → Domain List → Manage → Advanced DNS
  e) Add a new CNAME record:
     Type:  CNAME
     Host:  aviator
     Value: xyz.railway.app  (use what Railway gave you)
     TTL:   Automatic

  f) Wait 5–30 minutes for DNS to propagate
  g) Your game is now live at aviator.surveynx.com

════════════════════════════════════════════════════════════════════
OPTION A — NAMECHEAP VPS (Most control, ~$6/month)
════════════════════════════════════════════════════════════════════

STEP 1: Buy a VPS on Namecheap
  a) Go to namecheap.com → Hosting → VPS Hosting
  b) Choose "Pulsar" plan ($6.88/month) — 2GB RAM, plenty for this app
  c) Select Ubuntu 22.04 LTS as the operating system
  d) Complete purchase
  e) Check email for: IP address, root password, SSH details

STEP 2: Connect to your VPS
  Windows users:
    a) Download PuTTY from: putty.org
    b) Open PuTTY
    c) Host Name: (your VPS IP address, e.g. 45.76.123.456)
    d) Port: 22
    e) Click Open
    f) Login as: root
    g) Password: (from your email)

  Mac/Linux users:
    a) Open Terminal
    b) Type: ssh root@YOUR_VPS_IP
    c) Enter your password

STEP 3: Update the server and install Node.js
  Copy and paste these commands one by one:

  # Update system
  apt update && apt upgrade -y

  # Install Node.js 18 (LTS)
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt install -y nodejs

  # Verify
  node --version
  # Should show: v18.x.x

  # Install PM2 (keeps app running forever)
  npm install -g pm2

  # Install Nginx (web server / reverse proxy)
  apt install -y nginx

  # Install MySQL
  apt install -y mysql-server

  # Install Redis
  apt install -y redis-server

STEP 4: Secure MySQL
  mysql_secure_installation
  # Follow the prompts:
  # Set root password: Yes → choose a strong password
  # Remove anonymous users: Yes
  # Disallow root login remotely: Yes
  # Remove test database: Yes
  # Reload privileges: Yes

STEP 5: Create the database
  # Login to MySQL
  mysql -u root -p
  # Enter your MySQL root password

  # Run these SQL commands:
  CREATE DATABASE mkopscle_crashgame CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  CREATE USER 'mkopscle_crashgame'@'localhost' IDENTIFIED BY 'YourStrongPassword123!';
  GRANT ALL PRIVILEGES ON mkopscle_crashgame.* TO 'mkopscle_crashgame'@'localhost';
  FLUSH PRIVILEGES;
  EXIT;

STEP 6: Start Redis
  systemctl enable redis-server
  systemctl start redis-server
  # Verify: redis-cli ping
  # Should say: PONG

STEP 7: Upload your project files
  # On your LOCAL computer, open a new terminal/command prompt

  # Install FileZilla (free FTP/SFTP client) from filezilla-project.org
  # Connect with:
  #   Host: sftp://YOUR_VPS_IP
  #   Username: root
  #   Password: your VPS password
  #   Port: 22

  # Upload the entire aviator/ folder to: /var/www/aviator/

  # OR use the command line (from your local computer):
  scp -r /path/to/aviator root@YOUR_VPS_IP:/var/www/

STEP 8: Install dependencies on the server
  # Back in your SSH terminal:
  cd /var/www/aviator
  npm install --production

STEP 9: Configure your .env file
  # Edit the .env file on the server:
  nano /var/www/aviator/.env

  # Update these values:
  DB_HOST=localhost
  DB_NAME=mkopscle_crashgame
  DB_USER=mkopscle_crashgame
  DB_PASS=YourStrongPassword123!
  REDIS_HOST=127.0.0.1
  REDIS_PORT=6379
  JWT_SECRET=paste_a_very_long_random_string_here_50_chars_min
  SESSION_SECRET=another_completely_different_long_random_string
  PAYSTACK_PUBLIC_KEY=pk_live_your_key
  PAYSTACK_SECRET_KEY=sk_live_your_key
  PORT=3000
  NODE_ENV=production

  # Save: Ctrl+X → Y → Enter

STEP 10: Start the application with PM2
  cd /var/www/aviator
  pm2 start server/index.js --name crownpesa-aviator
  pm2 save          # Save process list
  pm2 startup       # Auto-start on server reboot
  # Copy and run the command it outputs

  # Check it's running:
  pm2 status
  pm2 logs crownpesa-aviator

STEP 11: Configure Nginx as reverse proxy

  # Create Nginx config:
  nano /etc/nginx/sites-available/crownpesa

  # Paste this (replace surveynx.com with your domain):
---
server {
    listen 80;
    server_name surveynx.com www.surveynx.com;

    # WebSocket support
    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }
}
---

  # Enable the site:
  ln -s /etc/nginx/sites-available/crownpesa /etc/nginx/sites-enabled/
  nginx -t          # Test config (should say: syntax is ok)
  systemctl restart nginx

STEP 12: Install free SSL certificate (HTTPS)
  # Install certbot:
  apt install -y certbot python3-certbot-nginx

  # Get certificate (replace with your domain):
  certbot --nginx -d surveynx.com -d www.surveynx.com

  # Follow prompts:
  # Enter email: your@email.com
  # Agree to terms: Y
  # Share email with EFF: N
  # Redirect HTTP to HTTPS: 2 (Yes)

  # Certificate auto-renews — test renewal:
  certbot renew --dry-run

STEP 13: Point your Namecheap domain to your VPS
  a) Go to namecheap.com → Domain List → Manage → Advanced DNS

  b) Delete any existing A records for @ and www

  c) Add these records:
     Type:  A Record
     Host:  @
     Value: YOUR_VPS_IP_ADDRESS
     TTL:   Automatic

     Type:  A Record
     Host:  www
     Value: YOUR_VPS_IP_ADDRESS
     TTL:   Automatic

  d) Wait 5–60 minutes for DNS propagation

  e) Visit https://surveynx.com — your game is live!

STEP 14: Set yourself as admin
  # On the server, login to MySQL:
  mysql -u mkopscle_crashgame -p mkopscle_crashgame
  # Enter your DB password

  # Run:
  UPDATE users SET is_admin=1 WHERE email='your@email.com';
  EXIT;

  # Now go to the Admin panel on your site and you'll see the dashboard

════════════════════════════════════════════════════════════════════
DAILY MANAGEMENT COMMANDS
════════════════════════════════════════════════════════════════════

  # Check app status:
  pm2 status

  # View live logs:
  pm2 logs crownpesa-aviator

  # Restart app (after updating code):
  cd /var/www/aviator && git pull && pm2 restart crownpesa-aviator

  # View error logs:
  tail -f /var/www/aviator/logs/error.log

  # Check MySQL:
  mysql -u mkopscle_crashgame -p mkopscle_crashgame

  # Check Redis:
  redis-cli ping

  # Check Nginx:
  systemctl status nginx

════════════════════════════════════════════════════════════════════
TROUBLESHOOTING
════════════════════════════════════════════════════════════════════

Problem: App won't start
  Solution: pm2 logs crownpesa-aviator
  Look for the error message — usually wrong DB credentials in .env

Problem: WebSocket not connecting
  Solution: Make sure Nginx config has the Upgrade/Connection headers
  (already included in the config above)

Problem: Game is slow / lagging
  Solution: Check Redis is running: redis-cli ping
  If PONG → Redis is fine
  If error → sudo systemctl start redis-server

Problem: "Cannot connect to database"
  Solution: Check .env DB credentials match what you created in Step 5
  Test: mysql -u mkopscle_crashgame -p mkopscle_crashgame

Problem: Domain not working
  Solution: Wait 30–60 minutes for DNS propagation
  Check propagation: https://www.whatsmydns.net

Problem: SSL certificate error
  Solution: sudo certbot renew
  Or re-run: sudo certbot --nginx -d yourdomain.com

════════════════════════════════════════════════════════════════════
PAYSTACK SETUP (Payments)
════════════════════════════════════════════════════════════════════

  1. Sign up at paystack.com/signup
  2. Complete business verification (required for live payments)
  3. Dashboard → Settings → API Keys
  4. Copy Live Public Key → paste in .env as PAYSTACK_PUBLIC_KEY
  5. Copy Live Secret Key → paste in .env as PAYSTACK_SECRET_KEY
  6. Dashboard → Settings → Webhooks → Add URL:
     https://surveynx.com/api/webhook/paystack
  7. pm2 restart crownpesa-aviator

════════════════════════════════════════════════════════════════════
COST SUMMARY
════════════════════════════════════════════════════════════════════

  Namecheap VPS Pulsar:     $6.88/month
  Namecheap Domain:         ~$10/year (you already have it)
  SSL Certificate:          FREE (Let's Encrypt)
  Redis:                    FREE (runs on your VPS)
  MySQL:                    FREE (runs on your VPS)
  
  TOTAL:  ~$7/month

  OR

  Railway.app Hobby plan:   $5/month (after free tier)
  MySQL addon:              ~$5/month
  
  TOTAL:  ~$10/month (but fully managed, no server work)
