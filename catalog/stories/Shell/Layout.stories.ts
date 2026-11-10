import Layout from "../../../site/src/components/Layout.astro";
import { page } from "../../story";

export default { component: Layout };

export const Repository = {
  args: {
    page: page("dashboard"),
    lead: "The top bar names the place and switches repos; the rail holds the repo's pages under the way back to the hub.",
  },
};
export const Hub = { args: { page: page("hub"), lead: "The hub's menu and every repository." } };
// What every page says once a build or a read failed, as admin-serve fills it in.
export const WithANotice = {
  args: {
    page: page("hub"),
    lead: "The hub after a failed build, keeping the pages it built before.",
    notice:
      '<p><b>The hub could not rebuild on 2 Jan at 09:05.</b> These pages show the repositories as of 2 Jan at 08:40. It tries again a minute later, or once a repository changes; nothing to do unless this stays, and then the terminal running admin-serve shows the whole error.</p><ul class="hw-marker-list"><li>The build stopped: build failed: TypeError: a sample error</li></ul>',
  },
};
