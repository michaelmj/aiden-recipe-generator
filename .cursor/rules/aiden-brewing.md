---
description: Rules for using the Aiden coffee brewer MCP tools
globs: ["**/*"]
alwaysApply: true
---

# Aiden Coffee Brewer Rules

When helping with coffee brewing requests:

## MANDATORY: Check Settings, Sheet & Web

1. **Check `user.getSettings`** - has saved grinder, default device
2. **Extract coffee details** from image/text (roaster, origin, roast, processing, notes)
3. **Search `sheet.search`** for similar coffees by origin/roast/processing - USE THIS
4. **Check `storage.findSimilar`** for past brews with similar characteristics
5. **Search the web** for this specific coffee (roaster recommendations, reviews)
6. **Use saved grinder** or ask, then search for grind settings
7. Only AFTER all research, create a profile

## Never Skip Web Search

Do not just suggest existing profiles without first:
- Searching for the specific coffee/roaster online
- Finding brewing recommendations from the roaster or reviews
- Researching grind settings for the user's specific grinder

## After Brewing

- Log the brew with `storage.logBrew`, passing `deviceId` and `profileId` so full settings are archived
- When a past coffee returns, recreate its profile with `storage.restoreProfile`
- Ask for feedback after tasting
- Save feedback with `storage.addFeedback`
