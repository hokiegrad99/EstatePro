import os

files = [
    'dashboard.html', 'tasks.html', 'executor.html', 'decedent.html',
    'assets.html', 'debts.html', 'cashflow.html', 'heirs.html', 'distributions.html'
]

users_svg = '<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 00-3-3.87"></path><path d="M16 3.13a4 4 0 010 7.75"></path></svg> Users</a></li>'

# The stray duplicate users line (without opening <li><a>)
stray_users = '<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 00-3-3.87"></path><path d="M16 3.13a4 4 0 010 7.75"></path></svg> Users</a></li>'

for fname in files:
    if not os.path.exists(fname):
        continue
    with open(fname, 'r') as f:
        content = f.read()

    # Fix duplicate stray users line
    if stray_users in content:
        content = content.replace(stray_users, '', 1)
        print(f"Fixed stray users in {fname}")

    # Fix distributions.html unique corruption
    if fname == 'distributions.html':
        broken = '<li><a href="distributions.html" class="active">\n      </ul>'
        if broken in content:
            dist_svg = '<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg> Distributions</a></li>'
            users_link = '<li><a href="users.html">' + users_svg
            content = content.replace(broken, '<li><a href="distributions.html" class="active">' + dist_svg + '\n        ' + users_link + '\n      </ul>')
            print(f"Fixed distributions.html")

    with open(fname, 'w') as f:
        f.write(content)
