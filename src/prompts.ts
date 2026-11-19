/**
 * MCP Prompts - guided workflows for common tasks.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

export function registerPrompts(server: McpServer) {
  server.prompt(
    'brew-from-bag',
    'Create a brew recipe from a coffee bag photo or description',
    {
      coffeeInfo: z
        .string()
        .describe('Photo description, bag text, or coffee details (origin, roast, processing, tasting notes)'),
      grinder: z.string().optional().describe("User's grinder model. If not provided, ask the user.")
    },
    ({ coffeeInfo, grinder }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Help me create an Aiden brew recipe for this coffee:

${coffeeInfo}

IMPORTANT: Always search the web first before suggesting any recipe. Do not skip this step.

Follow this workflow:

1. **Extract coffee details** - Identify origin, roast level, processing method, varietal, and tasting notes from the provided info.

2. **Search the web FIRST** - This is mandatory. Look up this specific coffee online to find:
   - Roaster's brewing recommendations
   - Reviews mentioning extraction tips
   - Any existing Aiden/Fellow recipes shared by others
   - More details about the coffee's characteristics

3. **Search community recipes** - Use sheet.search or sheet.list to find community recipes matching this coffee's characteristics (origin, roast, processing).

4. **Check brew history** - Use storage.findSimilar to find past brews with similar coffee (same origin, roast, or processing). Learn from what worked and what didn't based on feedback ratings.

5. **Apply coffee science** - Based on the coffee's characteristics:
   - Light roasts: higher temps (96-99°C), longer bloom, higher ratio (1:16-17)
   - Dark roasts: lower temps (85-92°C), shorter bloom, lower ratio (1:14-16)
   - Washed process: cleaner flavors, can handle higher temps
   - Natural process: fruitier, often benefits from slightly lower temps
   - High altitude origins: denser beans, can handle more extraction

6. **Create the recipe** - If storage.search finds this coffee logged before, recreate its profile with storage.restoreProfile instead of starting over. Otherwise combine insights from web research, community recipes, past brews, and coffee science into a whole recipe (bloom plus single-serve and batch pulse steps with temperatures). Use aiden.createProfile to save it under a title not already used by a Custom profile; profiles are named by title, never by device id.

7. **Log the brew** - Use storage.logBrew with the deviceId and the profile title to record this attempt with its whole recipe, so the profile can be restored after it leaves the brewer. After I taste it, ask for feedback so we can learn for next time.

8. **Grind settings** - ${grinder ? `Search the web for "${grinder} grind setting for pourover" or "batch brew" to find the recommended setting for this roast level. Look for specific click counts, dial positions, or numeric settings.` : "Ask the user which grinder they use, then search the web for that grinder's recommended pourover/batch brew settings for this roast level."}

9. **Explain your reasoning** - Tell me why you chose these parameters, the grind setting, what you found online, and what flavors to expect.`
          }
        }
      ]
    })
  );

  server.prompt(
    'troubleshoot',
    'Diagnose and fix a brew that tastes off',
    {
      issue: z.string().describe("What's wrong with the taste (sour, bitter, weak, harsh, etc.)"),
      profileTitle: z.string().optional().describe('Title of the profile used (optional)')
    },
    ({ issue, profileTitle }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `My coffee tastes ${issue}${profileTitle ? ` (using profile "${profileTitle}")` : ''}.

Help me fix it:

1. **Get current profile** - ${profileTitle ? `Use aiden.listProfiles to find the profile titled "${profileTitle}" and show its current settings.` : 'Ask me which profile I used, or list my profiles with aiden.listProfiles.'}

2. **Diagnose the issue**:
   - Sour/acidic → under-extracted (need higher temp, longer bloom, or finer grind)
   - Bitter/harsh → over-extracted (need lower temp, shorter bloom, or coarser grind)
   - Weak/watery → ratio too high or water not hot enough
   - Astringent → water too hot or too much agitation

3. **Suggest specific adjustments** - Based on the diagnosis, recommend exact parameter changes (e.g., "increase bloom temp from 94°C to 96°C").

4. **Offer to update** - Ask if I want you to update the profile with these changes using aiden.updateProfile, naming it by title.`
          }
        }
      ]
    })
  );
}
