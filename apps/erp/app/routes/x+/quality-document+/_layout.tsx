import { msg } from "@lingui/core/macro";
import type { MetaFunction } from "react-router";
import { Outlet } from "react-router";
import type { Handle } from "~/utils/handle";
import { path } from "~/utils/path";

export const meta: MetaFunction = () => {
  return [{ title: "Dhivio | Quality Document" }];
};

export const handle: Handle = {
  breadcrumb: msg`Quality`,
  to: path.to.quality,
  module: "quality"
};

export default function QualityDocumentRoute() {
  return <Outlet />;
}
