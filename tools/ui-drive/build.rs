fn main() {
    println!("cargo:rerun-if-changed=protocol/wlr-virtual-pointer-unstable-v1.xml");
    println!("cargo:rerun-if-changed=protocol/virtual-keyboard-unstable-v1.xml");
}
