import { msg } from "@lingui/core/macro";
import type { MetaFunction } from "react-router";
import { Outlet } from "react-router";
import type { Handle } from "~/utils/handle";
import { path } from "~/utils/path";

export const meta: MetaFunction = () => {
  return [{ title: "Dhivio | Training" }];
};

export const handle: Handle = {
  breadcrumb: msg`Resources`,
  to: path.to.resources,
  module: "resources"
};

export default function ResourcesRoute() {
  return <Outlet />;
}
