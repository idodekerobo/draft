"use client";

import Script from "next/script";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

const PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID;

export default function MetaPixel() {
  const pathname = usePathname();
  const isFirstRender = useRef(true);

  // Visitors who send Global Privacy Control never load the pixel, so window.fbq stays undefined.
  // The snippet fires the first PageView; this covers client-side navigation.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    window.fbq?.("track", "PageView");
  }, [pathname]);

  if (!PIXEL_ID) return null;

  return (
    <Script id="meta-pixel" strategy="afterInteractive">
      {`if(!navigator.globalPrivacyControl){!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${PIXEL_ID}');fbq('track','PageView');}`}
    </Script>
  );
}
