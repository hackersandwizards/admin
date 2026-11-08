import Shot from "../../../site/src/components/Shot.astro";
import { item } from "../../story";

export default { component: Shot };

const [image] = item("pick-a-variant").optionImages.b!;
export const Captioned = { args: { ...image, alt: "Variant B" } };
export const Small = { args: { ...image, alt: "Variant B", small: true } };
export const Bare = { args: { src: image!.src, alt: "Variant B" } };
