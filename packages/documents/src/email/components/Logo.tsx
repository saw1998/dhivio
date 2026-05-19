import { Img, Section } from "@react-email/components";

export function Logo() {
  return (
    <Section className="mt-[32px]">
      <Img
        src="https://erp.dhivio.com/carbon-word-light.png"
        width="auto"
        height="45"
        alt="Dhivio"
        className="mb-4 mx-auto block"
      />
    </Section>
  );
}
