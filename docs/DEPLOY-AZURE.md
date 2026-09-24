# Deploying on Azure

A click-by-click guide to a real deployment: an Ubuntu VM, Azure OpenAI, handwriting reading, your own domain and HTTPS. The `deploy/` scripts work on any Ubuntu server, so most of this applies elsewhere too.

About 45 minutes, all from the Azure portal in your browser. No laptop terminal needed.

Put everything in **the same region** (for example your nearest region), so the parts talk to each other quickly.

---

## 1. Protect your wallet first (2 minutes)

1. In the portal search for **Cost Management**, then **Budgets**, then **Add**.
2. Amount **$5** monthly, alert at 80%, with your email. Create.

Worth knowing: Azure's 12-month free allowances start when the subscription is created, and when they run out **billing simply continues** at normal rates. The budget alert is what warns you.

## 2. Azure OpenAI (you already have this)

Open your **Azure OpenAI** resource and note three things:

| You'll need | Where |
|---|---|
| Endpoint | **Keys and Endpoint**, then add `/openai/v1` to the end, e.g. `https://myschool.openai.azure.com/openai/v1` |
| Deployment name | **Model deployments**: the name *you* gave the deployment, not the model name |
| Key | **Keys and Endpoint**, then KEY 1 |

If you don't have a deployment yet, create one (a small chat model like GPT-4o mini is plenty for notes).

## 3. Document Intelligence, for handwritten notes (5 minutes)

This is what lets the AI read scanned and handwritten pages.

1. Search **Document Intelligence**, then **Create**.
2. Same region and resource group. Pricing tier: **Standard S0**.
   The free F0 tier only reads the **first two pages** of a PDF, which isn't enough for real notes. S0 costs roughly a rupee or two per page, and typed PDFs never use it at all.
3. After it deploys, open **Keys and Endpoint** and copy the **endpoint** and **KEY 1**.

## 4. Create the server (10 minutes)

1. Search **Virtual machines**, then **Create**, then **Azure virtual machine**.
2. **Name:** `astron`
3. **Region:** same as above
4. **Image:** **Ubuntu Server 24.04 LTS**
5. **Size:** `B2ats v2` (2 vCPU) if your free allowance covers it, otherwise `B1s`. Both sit in the 750-hours-a-month free allowance for the first 12 months.
6. **Authentication:** SSH public key. Username `azureuser`. Choose **Generate new key pair**, name it `astron-key`.
7. **Inbound ports:** tick **SSH (22)**, **HTTP (80)** and **HTTPS (443)**.
8. **Disks:** OS disk **64 GiB**, **Premium SSD**. (This is the disk Astron's storage bar reads.)
9. **Review + create**, then **Create**. When prompted, **Download private key and create resource** and keep the `astron-key.pem` file.
10. When it's ready, open the VM and copy its **Public IP address**.

## 5. Install Astron (10 minutes)

1. Click the **Cloud Shell** icon (`>_`) in the top bar of the portal. Choose **Bash**. Create storage if asked.
2. Click the **Upload/Download files** icon, then **Upload**, and upload **both** `astron-key.pem` and `astron.zip`.
3. Paste these one at a time, replacing `VM_IP` with your VM's public IP:

```
chmod 600 astron-key.pem
scp -i astron-key.pem astron.zip azureuser@VM_IP:~
ssh -i astron-key.pem azureuser@VM_IP
```

4. Now you're on the server. Paste:

```
sudo apt-get update && sudo apt-get install -y unzip
unzip astron.zip && cd astron
sudo bash deploy/setup.sh
```

5. The setup asks for:
   - **What the site is called**
   - **Admin username**, **your name**, and a **temporary admin password** (8+ characters)
   - **AI base URL, deployment name and key** from step 2
   - **Document Intelligence endpoint and key** from step 3
   - **Which port the site should use.** 80 is normal; pick another if something already uses it.

   It writes `.env` for you. Everything else — your course, keys and limits — is set from the site once you're signed in, on the **Manage course** and **Settings** pages.

   Keys are hidden as you type and are stored only on this server.

At the end it prints your address, like `http://20.40.x.x`.

## 6. First sign-in

1. Open that address and sign in with your admin username and temporary password.
2. Choose your real password.
3. **People**: add your friends. Astron suggests a temporary password for each; send them the username and temporary password yourself.
4. Open a subject and unit and use **Add files** to upload notes. Typed PDFs are searchable by the AI within seconds; handwritten ones take a little longer while Document Intelligence reads them. A file shows "reading for AI…" until it's done.

## 6b. Turning handwritten pages into typed notes

Admin only. In the **Raw inbox** (or a unit's Raw tab), tick the pages you want, then press **Type these up with AI**.

- Pick pages from one unit at a time, up to 12 at once.
- Each page is sent to your Azure OpenAI model as an image, along with whatever Document Intelligence read from it, so layout and equations survive.
- You get a preview with the maths properly rendered. **Check it, especially derivations**, then Save.
- It lands in that unit's Notes, tagged **AI draft** until you press "Mark as checked".
- Notes can be edited any time (Read / Edit), and **Save as PDF** prints a clean copy.
- The raw pages it came from are marked "used" automatically.
- **"Don't redraw diagrams"** skips the drawing step and just keeps your photo, saving one AI call per figure.
- **Diagrams get redrawn, and the original is kept.** Where the page has a figure, the AI draws a clean version and the matching part of your photo is tucked behind a "Show the original page" toggle underneath, so you can check it. A drawn diagram can be wrong, so always compare before marking the notes as checked.
- **Notebook style.** Notes display like typed study notes: white page, handwriting font, blue ink, maroon headings. The toggle switches back to the dark style, and printing always uses the notebook look.

Cost is per page, once. "Faster, lower detail" is cheaper and fine for clean printed handouts; leave it off for handwriting.

## 7. Your domain and HTTPS

Astron doesn't set up certificates for you. Two straightforward routes:

**Behind Cloudflare (easiest).** Point your domain's A record at the server with the proxy on, set SSL/TLS mode to Full (strict), and create an Origin Certificate in Cloudflare to install in nginx. Visitors get HTTPS and the server never faces the internet directly.

**Your own certificate.** Install one however you prefer (certbot, a purchased certificate, your college's) and add it to `/etc/nginx/sites-available/astron`.

Either way, once the site is served over HTTPS set `COOKIE_SECURE=true` in `/opt/astron/.env` and restart, so sign-in cookies are only sent over an encrypted connection.

Until HTTPS is on, passwords travel in the clear. Fine for a first test on a private network, not for everyday use.

---

## Everyday tasks

| To do this | Run this after `ssh -i astron-key.pem azureuser@VM_IP` |
|---|---|
| See what the server is doing | `sudo journalctl -u astron -f` |
| Change the site name, keys or limits | `sudo nano /opt/astron/.env` then `sudo systemctl restart astron` |
| Back up everything | `sudo bash /opt/astron/deploy/backup.sh` |
| Install a new version | upload the new zip, `unzip`, `cd astron`, `sudo bash deploy/update.sh` |

## If something goes wrong

- **Site won't load:** check ports 80 and 443 are allowed on the VM's **Networking** page.
- **"The AI provider refused the key (401)":** wrong key, or the endpoint is missing `/openai/v1`.
- **"Azure returned 404":** your resource uses the older style. `sudo nano /opt/astron/.env`, set `AI_BASE_URL` to the plain endpoint (without `/openai/v1`), add `AI_FORMAT=azure` and `AI_API_VERSION=2024-10-21`, then restart.
- **Handwritten notes show "AI can't read this":** check `AZURE_DI_ENDPOINT` and `AZURE_DI_KEY`, and that the resource is **S0**, not free F0.
- **Someone forgot their password:** People, then Reset password.
- **Site feels slow on a 1 GB VM:** stop it and resize to `B2ats v2` in the portal.
