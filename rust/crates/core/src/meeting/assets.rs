use super::bridge::{Asset, ViewAssets};

impl Default for ViewAssets {
    fn default() -> Self {
        Self {
            assets: [
                (
                    "/view",
                    "text/html; charset=utf-8",
                    include_str!("../../../../../extensions/meeting/view/index.html"),
                ),
                (
                    "/view/style.css",
                    "text/css; charset=utf-8",
                    concat!(
                        include_str!("../../../../../extensions/meeting/view/fonts.css"),
                        "\n",
                        include_str!("../../../../../extensions/meeting/view/style.css")
                    ),
                ),
                (
                    "/view/app.js",
                    "text/javascript; charset=utf-8",
                    include_str!("../../../../../extensions/meeting/view/app.js"),
                ),
                (
                    "/view/model.js",
                    "text/javascript; charset=utf-8",
                    include_str!("../../../../../extensions/meeting/view/model.js"),
                ),
                (
                    "/view/capture.js",
                    "text/javascript; charset=utf-8",
                    include_str!("../../../../../extensions/meeting/view/capture.js"),
                ),
                (
                    "/view/delivery.js",
                    "text/javascript; charset=utf-8",
                    include_str!("../../../../../extensions/meeting/view/delivery.js"),
                ),
                (
                    "/view/worklet.js",
                    "text/javascript; charset=utf-8",
                    include_str!("../../../../../extensions/meeting/view/worklet.js"),
                ),
                (
                    "/view/mark.svg",
                    "image/svg+xml",
                    include_str!("../../../../../assets/brand/ycoding-mark.svg"),
                ),
            ]
            .into_iter()
            .map(|(route, content_type, body)| {
                (
                    route.to_owned(),
                    Asset {
                        content_type: content_type.to_owned(),
                        body: body.to_owned(),
                    },
                )
            })
            .collect(),
            policy: "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self'; font-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'".into(),
        }
    }
}
