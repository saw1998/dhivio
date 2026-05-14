import { Heading, VStack } from "@carbon/react";
import { msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { MetaFunction } from "react-router";
import { Outlet } from "react-router";
import type { Handle } from "~/utils/handle";
import { path } from "~/utils/path";

export const meta: MetaFunction = () => {
  return [{ title: "Dhivio | My Account" }];
};

export const handle: Handle = {
  breadcrumb: msg`Account`,
  to: path.to.profile,
  module: "account"
};

export default function AccountRoute() {
  // const { links } = useAccountSubmodules();

  return (
    <div className="flex min-h-full w-full flex-col gap-4 bg-card">
      <div className="w-full shrink-0 border-b border-border">
        <div className="mx-auto w-full max-w-[60rem] px-2 py-8">
          <Heading size="h3">
            <Trans>Account Settings</Trans>
          </Heading>
        </div>
      </div>

      <div className="mx-auto w-full max-w-[60rem] flex-1 px-2">
        <div className="grid w-full grid-cols-1 gap-8">
          {/* <DetailSidebar links={links} /> */}
          <VStack spacing={0} className="h-full w-full">
            <Outlet />
          </VStack>
        </div>
      </div>
    </div>
  );
}
