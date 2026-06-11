import os
import re

files = [
    'dashboard.html', 'tasks.html', 'executor.html', 'decedent.html',
    'assets.html', 'debts.html', 'cashflow.html', 'heirs.html', 'distributions.html'
]

for fname in files:
    if not os.path.exists(fname):
        continue
    with open(fname, 'r') as f:
        content = f.read()

    # Check if file is corrupted
    if '<li><a href="distributions.html">\n        <li><a href="users.html">' not in content:
        print(f"Skipping {fname} (not corrupted)")
        continue

    # Determine active class for this file
    distributions_active = 'class="active"' if fname == 'distributions.html' else ''
    users_active = 'class="active"' if fname == 'users.html' else ''

    # Build correct replacement
    dist_link = f'<li><a href="distributions.html" {distributions_active}><svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg> Distributions</a></li>'
    users_link = f'<li><a href="users.html" {users_active}><svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 00-3-3.87"></path><path d="M16 3.13a4 4 0 010 7.75"></path></svg> Users</a></li>'

    replacement = dist_link + '\n        ' + users_link

    # Fix the corrupted pattern
    content = content.replace(
        '<li><a href="distributions.html">\n        <li><a href="users.html">',
        replacement
    )

    with open(fname, 'w') as f:
        f.write(content)
    print(f"Fixed {fname}")
