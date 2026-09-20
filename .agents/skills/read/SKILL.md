---
name: read
description: Read a file, or part of one, efficiently and without wasting tokens
---

# Read File

Read $ARGUMENTS efficiently:

1. If a whole file was passed, look at its structure first:
   head -50 {file}

2. Find the part you need with grep:
   grep -n "function\|class\|export" {file}

3. Read only the lines you need:
   sed -n 'N,Mp' {file}

4. For JSON files, use jq:
   cat {file} | jq '.the_field_you_need'

5. For a Prisma schema, only the model you need:
   sed -n '/model {Name}/,/^}/p' {file}

Never read a whole file when you need one function or one model.
