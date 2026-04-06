# Dev workflow (veg-order-app)

## Rule
After **every code change** that affects runtime behavior, do:
1) `node -c server.js`
2) `systemctl restart veg-order.service`
3) quick smoke test:
   - `curl -fsS http://127.0.0.1:3100/healthz`
4) Commit + push to GitHub:
   - `git status`
   - `git add -A`
   - `git commit -m "<short message>"`
   - `git push`

## Rollback
- View history: `git log --oneline --decorate -n 20`
- Roll back to a commit:
  - `git reset --hard <commit>`
  - `systemctl restart veg-order.service`

Repo: git@github.com:job428/Monday_bot.git
