with open("pnpm-workspace.yaml", "r") as f:
    content = f.read()

# Update the security pins
updates = {
    "hono: '4.12.31'": "hono: '4.12.34'",
    "fast-uri: '3.1.4'": "fast-uri: '3.1.5'",
    "ip-address: '10.2.0'": "ip-address: '10.2.1'",
}

for old, new in updates.items():
    if old in content:
        content = content.replace(old, new)
        print(f"  Updated {old.split(':')[0]}: {old.split(\"'\")[1]} -> {new.split(\"'\")[1]}")
    else:
        print(f"  WARNING: {old} not found!")

with open("pnpm-workspace.yaml", "w") as f:
    f.write(content)
print("Done updating overrides")
