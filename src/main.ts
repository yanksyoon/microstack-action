import * as core from '@actions/core'
import * as exec from '@actions/exec'

enum INPUT_OPTIONS {
  FLAVOR = 'flavor',
  CORES = 'cores',
  MEMORY = 'mememory',
  DISK = 'disk'
}

const DEFAULT_FLAVOR = '24.04'
const DEFAULT_NUM_CORES = '6'
const DEFAULT_SIZE_MEM = '32GiB'
const DEFAULT_SIZE_DISK = '50GB'
const OPENSTACK_VM_NAME = 'openstack'

const UBUNTU_UID = '1000'
// const SNAP_DAEMON_GID = '584788'
// Use sudo -i -u 1000 due to: https://bugs.launchpad.net/snapd/+bug/2075560
const EXEC_COMMAND_UBUNTU_USER = `lxc exec ${OPENSTACK_VM_NAME} -- sudo -i -u ${UBUNTU_UID}`
// const SUNBEAM_ADMIN_CLOUD_NAME = 'sunbeam-admin'
const OPENSTACK_CLOUDS_YAML_PATH = '~/.config/openstack/clouds.yaml'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const flavor: string = core.getInput(INPUT_OPTIONS.FLAVOR) || DEFAULT_FLAVOR
    const cores: string =
      core.getInput(INPUT_OPTIONS.CORES) || DEFAULT_NUM_CORES
    const mem: string = core.getInput(INPUT_OPTIONS.MEMORY) || DEFAULT_SIZE_MEM
    const disk: string = core.getInput(INPUT_OPTIONS.DISK) || DEFAULT_SIZE_DISK

    // Setup OpenStack VM
    core.info('Initializing LXD')
    await exec.exec('sudo lxd init', ['--auto'])
    await exec.exec('lxc list')
    core.info('Launching VM')
    await exec.exec(
      `timeout 5m lxc --debug init ubuntu:${flavor} ${OPENSTACK_VM_NAME}` //  --vm -d root,size=${disk} -c limits.cpu=${cores} -c limits.memory=${mem}
    )
    await exec.exec(`timeout 5m lxc start ${OPENSTACK_VM_NAME}`)
    await exec.exec('lxc list')
    core.info('Installing OpenStack (Sunbeam) on VM')
    await exec.exec(
      `${EXEC_COMMAND_UBUNTU_USER} sudo snap install openstack --channel 2024.1/beta`
    )
    core.info('Preparing VM (Sunbeam)')
    await exec.exec(
      `${EXEC_COMMAND_UBUNTU_USER} bash -c "sunbeam prepare-node-script | bash -x"`
    )
    core.info('Bootstrapping cluster (Sunbeam)')
    // lxc exec openstack -- sudo -i -u ubuntu sunbeam cluster bootstrap --accept-defaults
    await exec.exec(
      `${EXEC_COMMAND_UBUNTU_USER} sunbeam cluster bootstrap --accept-defaults`
    )
    core.info('Fetching admin credentials (Sunbeam)')
    await exec.exec(
      `${EXEC_COMMAND_UBUNTU_USER} sunbeam cloud-config -a > ${OPENSTACK_CLOUDS_YAML_PATH}`
    )

    // Set up host to route requests to OpenStack
    // example output:
    // "10.248.96.56 (enp5s0)
    // 10.20.20.1 (br-ex)
    // 10.1.0.114 (cilium_host)"
    core.info('Setting up host IP routing')
    const interfaceOutput = await exec.getExecOutput(
      'lxc list --columns=4 --format=csv'
    )
    if (interfaceOutput.exitCode !== 0) {
      core.error(
        `lxc list command failed with return code: ${interfaceOutput.exitCode}`
      )
      core.setFailed(interfaceOutput.stderr)
      return
    }
    const interfaces = interfaceOutput.stdout.split(/(\s+)/)
    if (interfaces.length < 1) {
      core.error(`LXC failed to allocate interfaces, ${interfaces.join(',')}`)
      core.setFailed('Failed to fetch lxc network interfaces.')
      return
    }
    const gatewayIP = interfaces[0]
    // TODO: fetch sunbeam IP from cloud-config.yaml
    // $ sudo k8s get load-balancer.cidrs
    // [172.16.1.201-172.16.1.240]
    const sumbeamIP = '172.16.1.192/26'
    await exec.exec(`sudo ip route add ${sumbeamIP} via ${gatewayIP}`)
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}
