import {createRoot} from "react-dom/client";
import DopplerPage from "../app/doppler/page";
import "./base.css";
import "../app/doppler.css";
createRoot(document.getElementById("root")!).render(<DopplerPage/>);
